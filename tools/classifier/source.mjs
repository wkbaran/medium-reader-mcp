// The only source-specific part of the classifier tools: where this server's digest
// keeps its files, and how to read headlines out of a run file. Everything else in
// tools/classifier/ is shared with substack-reader-mcp.

export const SOURCE = {
  name: "Medium",
  /** Env prefix for this server's settings: <PREFIX>_CLASSIFIER, <PREFIX>_DIGEST_SKIP_THRESHOLD, … */
  prefix: "MEDIUM_READER",
  /** Env var holding the digest directory (state.json, interests.md, runs/). */
  digestDirEnv: "MEDIUM_READER_DIGEST_DIR",
};

/**
 * Headlines in one run file (runs/<id>.json, written by digest_begin).
 * Returns { id, title, subtitle?, author?, publication?, url?, run, pool, picked }.
 * `picked` is how the digest's model used it: "starred", "named", or undefined.
 */
export function headlinesFromRun(run) {
  const j = run.judgments ?? {};
  const starred = new Set((j.starred ?? []).map((s) => s.ref));
  const named = new Set([...(j.following ?? []), ...(j.top_picks ?? []), ...(j.for_you ?? [])].map((s) => s.ref));
  return (run.items ?? []).map((i) => ({
    id: i.id,
    title: i.title,
    subtitle: i.subtitle,
    author: i.author,
    publication: i.publication,
    url: i.url,
    run: run.run_id,
    pool: i.pool,
    picked: starred.has(i.ref) ? "starred" : named.has(i.ref) ? "named" : undefined,
  }));
}

/** Run files outside runs/ worth reading too (none for Medium: every run is in runs/). */
export function extraRunFiles(_digestDir) {
  return [];
}

/** The interests evidence the interests_evidence tool returns, gathered with the built server's code. */
export async function evidenceText({ digestDir, history = 120, listItems = 100, labels = "all" }) {
  const dist = (p) => new URL(`../../dist/${p}`, import.meta.url).href;
  const { ClientProvider } = await import(dist("server.js"));
  const { gatherEvidence } = await import(dist("digest/evidence.js"));
  const { renderEvidence } = await import(dist("classifier/evidence.js"));
  const ev = await gatherEvidence(await new ClientProvider().get(), digestDir, { history, listItems, labels });
  ev.saveHint = undefined; // propose.mjs saves the file itself
  return renderEvidence(ev);
}
