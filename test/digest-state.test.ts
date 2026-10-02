import { mkdir, mkdtemp, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { commitState, insideDir, isoSeconds, laterIso, listRunIds, loadState, newRunId, normalizeIds, pruneRuns, withLock, writeRun } from "../src/digest/state.js";

let dir: string;
const stateFile = () => join(dir, "state.json");
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => (from + i).toString(16).padStart(12, "a"));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "digest-state-"));
});

describe("loadState", () => {
  it("reports a missing file as a first run", async () => {
    expect(await loadState(dir)).toEqual({ status: "missing", state: null });
  });

  it("reports a corrupt file without touching it", async () => {
    await writeFile(stateFile(), "{ not json");
    const r = await loadState(dir);
    expect(r.status).toBe("corrupt");
    expect(await readFile(stateFile(), "utf8")).toBe("{ not json");
  });
});

describe("commitState", () => {
  it("round-trips an existing file byte for byte when nothing changes", async () => {
    const text = JSON.stringify({ last_run: "2026-10-02T12:15:24Z", reported_posts: ids(3), note: "kept" }, null, 2) + "\n";
    await writeFile(stateFile(), text);
    const r = await commitState(dir, { add: [], keep: 3000 });
    expect(r).toMatchObject({ added: 0, total: 3, lastRun: "2026-10-02T12:15:24Z" });
    expect(await readFile(stateFile(), "utf8")).toBe(text);
    expect((await readdir(dir)).sort()).toEqual(["state.json"]);
  });

  it("creates a new file with last_run first, mode 0644", async () => {
    const r = await commitState(dir, { add: ["ABCDEF123456", "abcdef123456"], lastRun: "2026-10-02T12:00:00Z", keep: 3000 });
    expect(r).toMatchObject({ added: 1, alreadyPresent: 0, total: 1 });
    expect(await readFile(stateFile(), "utf8")).toBe('{\n  "last_run": "2026-10-02T12:00:00Z",\n  "reported_posts": [\n    "abcdef123456"\n  ]\n}\n');
    expect((await stat(stateFile())).mode & 0o777).toBe(0o644);
  });

  it("de-duplicates keeping the last occurrence, keeps unknown keys, and backs up the old file", async () => {
    // Like the 2026-10-02 file: ids reported twice by hand-written patches.
    const old = { last_run: "2026-10-01T12:00:00Z", extra: { a: 1 }, reported_posts: ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "aaaaaaaaaaaa", "not-an-id"] };
    await writeFile(stateFile(), JSON.stringify(old, null, 2) + "\n");
    const r = await commitState(dir, { add: ["cccccccccccc", "bbbbbbbbbbbb"], lastRun: "2026-10-02T12:00:00Z", keep: 3000 });
    const saved = JSON.parse(await readFile(stateFile(), "utf8"));
    expect(saved.reported_posts).toEqual(["aaaaaaaaaaaa", "cccccccccccc", "bbbbbbbbbbbb"]);
    expect(saved.extra).toEqual({ a: 1 });
    expect(Object.keys(saved)).toEqual(["last_run", "extra", "reported_posts"]);
    expect(r).toMatchObject({ added: 1, alreadyPresent: 1, total: 3 });
    expect(r.warnings.join(" ")).toMatch(/Dropped 1 entries.*not-an-id/);
    expect(JSON.parse(await readFile(join(dir, "state.json.bak"), "utf8"))).toEqual(old);
    expect((await readdir(dir)).filter((n) => n.includes("tmp"))).toEqual([]);
  });

  it("keeps only the newest `keep` ids", async () => {
    await commitState(dir, { add: ids(10), keep: 4 });
    const saved = JSON.parse(await readFile(stateFile(), "utf8"));
    expect(saved.reported_posts).toEqual(ids(10).slice(6));
  });

  it("never moves last_run backwards", async () => {
    await commitState(dir, { add: [], lastRun: "2026-10-02T12:00:00Z", keep: 10 });
    const r = await commitState(dir, { add: [], lastRun: "2026-10-01T12:00:00Z", keep: 10 });
    expect(r.lastRun).toBe("2026-10-02T12:00:00Z");
    expect(laterIso("2026-10-02T12:00:00Z", "2026-10-03T00:00:00Z")).toBe("2026-10-03T00:00:00Z");
    expect(laterIso(undefined, "2026-10-03T00:00:00Z")).toBe("2026-10-03T00:00:00Z");
  });

  it("sets a corrupt file aside and starts again", async () => {
    await writeFile(stateFile(), "{ not json");
    const r = await commitState(dir, { add: ["aaaaaaaaaaaa"], keep: 10 });
    expect(r.warnings.join(" ")).toMatch(/corrupt/);
    const names = await readdir(dir);
    expect(names.some((n) => /^state\.json\.corrupt-\d{8}T\d{6}Z$/.test(n))).toBe(true);
    expect(JSON.parse(await readFile(stateFile(), "utf8")).reported_posts).toEqual(["aaaaaaaaaaaa"]);
  });

  it("refuses a symlinked state file", async () => {
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await writeFile(join(outside, "x.json"), "{}");
    await symlink(join(outside, "x.json"), stateFile());
    await expect(commitState(dir, { add: [], keep: 10 })).rejects.toThrow(/symlink/);
    expect(await readFile(join(outside, "x.json"), "utf8")).toBe("{}");
  });

  it("waits for a held lock and takes over a stale one", async () => {
    await writeFile(stateFile() + ".lock", "123");
    await expect(withLock(stateFile() + ".lock", async () => 1, { waitMs: 150 })).rejects.toThrow(/held by another run/);
    const old = new Date(Date.now() - 120_000);
    await utimes(stateFile() + ".lock", old, old);
    await commitState(dir, { add: ["aaaaaaaaaaaa"], keep: 10 });
    expect(await readdir(dir)).not.toContain("state.json.lock");
  });
});

describe("insideDir", () => {
  it("refuses paths that escape the digest directory", async () => {
    await expect(insideDir(dir, "..", "x")).rejects.toThrow(/outside/);
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await symlink(outside, join(dir, "runs"));
    await expect(insideDir(dir, "runs", "a.json")).rejects.toThrow(/outside/);
    await expect(insideDir(join(dir, "nope"), "state.json")).rejects.toThrow(/doesn't exist/);
  });
});

describe("normalizeIds", () => {
  it("lowercases, validates, de-duplicates keeping the last, and trims", () => {
    expect(normalizeIds(["AAAAAAAAAAAA", "bbbbbbbb", "zz", "aaaaaaaaaaaa", "cccccccccccc"], 2)).toEqual({ ids: ["aaaaaaaaaaaa", "cccccccccccc"], dropped: ["zz"] });
  });
});

describe("run files", () => {
  it("names runs by start time, avoids collisions, and keeps the newest 14", async () => {
    const t = new Date("2026-10-02T12:15:31.400Z");
    expect(isoSeconds(t)).toBe("2026-10-02T12:15:31Z");
    const first = await newRunId(dir, t);
    expect(first).toBe("20261002T121531Z");
    await writeRun(dir, first, {});
    const second = await newRunId(dir, t);
    expect(second).toBe("20261002T121531Z-2");
    await writeRun(dir, second, {});
    for (let d = 1; d <= 15; d++) await writeRun(dir, `202609${String(d).padStart(2, "0")}T000000Z`, {});
    await mkdir(join(dir, "runs", "ignored"));
    await pruneRuns(dir);
    const left = await listRunIds(dir);
    expect(left).toHaveLength(14);
    expect(left.slice(-2)).toEqual(["20261002T121531Z", "20261002T121531Z-2"]);
    expect(left[0]).toBe("20260904T000000Z");
  });
});
