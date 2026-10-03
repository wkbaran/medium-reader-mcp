/**
 * Medium's evidence for drafting interests.md (src/classifier/evidence.ts renders it):
 * reading lists and followed publications (strong), the digest's ⭐ picks (medium),
 * reading history (weak), and hand labels from tools/classifier (strong / negative).
 * Read-only: nothing here changes the account or the digest state.
 */
import { readFile } from "node:fs/promises";
import { isTrainLabel, labelSections, type Evidence, type EvidenceItem, type EvidenceSection } from "../classifier/evidence.js";
import type { MediumClient, PostSummary } from "../medium/api.js";
import { DIGEST_FILES } from "../config.js";
import { insideDir, listRunIds, readRun } from "./state.js";
import type { RunFile } from "./types.js";

export interface EvidenceOptions {
  /** Reading-history posts to include (0 = none). */
  history: number;
  /** Reading-list posts to include across all lists (0 = none). */
  listItems: number;
  /** "train": only the half of the hand labels reserved for drafting, so the other half can test the proposal. */
  labels?: "all" | "train";
}

const item = (p: PostSummary, note?: string): EvidenceItem => ({
  title: p.title,
  subtitle: p.subtitle,
  author: p.author,
  publication: p.publication,
  ...(note ? { note } : {}),
});

export async function gatherEvidence(client: MediumClient, dir: string | undefined, opts: EvidenceOptions): Promise<Evidence> {
  const sections: EvidenceSection[] = [];
  const warnings: string[] = [];
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      warnings.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await client.whoami(); // an expired session fails here, as an auth error

  if (opts.listItems > 0) {
    await attempt("reading lists", async () => {
      const lists = (await client.lists()).filter((l) => (l.count ?? 1) > 0);
      const seen = new Map<string, { post: PostSummary; lists: string[] }>();
      let total = 0;
      for (const l of lists) {
        total += l.count ?? 0;
        let cursor: string | undefined;
        let fetched = 0;
        do {
          const page = await client.listItems(l.id, { limit: 25, cursor });
          for (const p of page.items) {
            const e = seen.get(p.id) ?? { post: p, lists: [] };
            e.lists.push(l.name);
            seen.set(p.id, e);
          }
          fetched += page.items.length;
          cursor = page.nextCursor;
        } while (cursor && fetched < opts.listItems && seen.size < opts.listItems);
        if (seen.size >= opts.listItems) break;
      }
      if (seen.size) {
        sections.push({
          title: "Saved to reading lists",
          strength: "strong",
          about: `Posts the reader saved, from ${lists.length} list${lists.length === 1 ? "" : "s"} (${lists.map((l) => l.name).join(", ")}). Saving is a deliberate choice.`,
          items: [...seen.values()].slice(0, opts.listItems).map((e) => item(e.post, e.lists.length > 1 ? `in ${e.lists.length} lists` : undefined)),
          total,
        });
      }
    });
  }

  await attempt("followed publications", async () => {
    const pubs = await client.following({ kind: "publications", limit: 200 });
    if (pubs.items.length) {
      sections.push({
        title: "Followed publications",
        strength: "strong",
        about: "Publications the reader follows. Following is deliberate, but some follows are old; weigh names that also appear in other sections more.",
        lines: [pubs.items.map((p) => p.name).join(" · ")],
        total: pubs.total ?? pubs.items.length,
      });
    }
  });

  if (dir) {
    await attempt("digest picks", async () => {
      const starred: EvidenceItem[] = [];
      for (const id of await listRunIds(dir)) {
        const run = await readRun<RunFile>(dir, id);
        if (!run?.judgments) continue;
        const byRef = new Map(run.items.map((i) => [i.ref, i]));
        for (const s of run.judgments.starred) {
          const i = byRef.get(s.ref);
          if (i) starred.push({ title: i.title, subtitle: i.subtitle, author: i.author, publication: i.publication });
        }
      }
      if (starred.length) {
        sections.push({
          title: "Digest ⭐ Read-in-full picks",
          strength: "medium",
          about: "Posts the digest's model chose as the best of each day, from the last 14 runs. It picked from your feeds by its own judgment, so this reflects your current interests.md as much as your taste.",
          items: starred,
        });
      }
    });

    await attempt("labels", async () => {
      const labels = new Map<string, string>();
      for (const r of await jsonl(dir, "classifier", "labels.jsonl")) (r.label ? labels.set(String(r.id), String(r.label)) : labels.delete(String(r.id)));
      if (opts.labels === "train") for (const id of [...labels.keys()]) if (!isTrainLabel(id)) labels.delete(id);
      if (!labels.size) return;
      const dataset = new Map<string, EvidenceItem>();
      for (const r of await jsonl(dir, "classifier", "dataset.jsonl")) dataset.set(String(r.id), r as unknown as EvidenceItem);
      sections.push(...labelSections(labels, dataset));
    });
  }

  if (opts.history > 0) {
    await attempt("reading history", async () => {
      const page = await client.readingHistory({ limit: opts.history });
      if (page.items.length) {
        sections.push({
          title: "Reading history",
          strength: "weak",
          about: "Posts the reader opened, most recent first. Includes clicks they regretted; Medium gives no read time or completion.",
          items: page.items.slice(0, opts.history).map((p) => item(p)),
        });
      }
    });
  }

  let current: string | undefined;
  if (dir) current = await readFile(await insideDir(dir, DIGEST_FILES.interests), "utf8").catch(() => undefined);
  if (!dir) warnings.push("Digest picks, labels and the current interests.md: MEDIUM_READER_DIGEST_DIR isn't set.");
  if (!sections.some((s) => s.strength === "negative")) {
    warnings.push("No negative evidence (no labels marked skip): keep Skip as it is. Label headlines with tools/classifier/label.mjs to give it some.");
  }
  return {
    source: "Medium",
    current,
    sections,
    warnings,
    saveHint: dir
      ? "call save_interests_proposal with the complete proposed file (it's saved as interests.proposed.md; interests.md isn't touched), then show the reader the changes. They can compare both files against their labels with tools/classifier (score.mjs --interests …, then analyze.mjs) before adopting it."
      : undefined,
  };
}

async function jsonl(dir: string, ...parts: string[]): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(await insideDir(dir, ...parts), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}
