import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractSession, loadCredentials, saveCredentials } from "../src/auth/credentials.js";
import { paths } from "../src/config.js";

describe("extractSession", () => {
  it("reads a Cookie header", () => {
    expect(extractSession("Cookie: nonce=x; uid=abc123; sid=1:secret; xsrf=q")).toEqual({ sid: "1:secret", uid: "abc123" });
    expect(extractSession("sid=1:secret; uid=abc123")).toEqual({ sid: "1:secret", uid: "abc123" });
  });

  it("reads a Cookie-Editor export, ignoring other sites' sid cookies", () => {
    const json = JSON.stringify([
      { domain: ".example.com", name: "sid", value: "not-medium" },
      { domain: ".medium.com", name: "sid", value: "1:secret" },
      { domain: "medium.com", name: "uid", value: "abc123" },
    ]);
    expect(extractSession(json)).toEqual({ sid: "1:secret", uid: "abc123" });
    expect(extractSession(JSON.stringify({ cookies: [{ name: "sid", value: "1:x" }] }))).toEqual({ sid: "1:x" });
  });

  it("reads cookies.txt", () => {
    const txt = [
      "# Netscape HTTP Cookie File",
      ".other.com\tTRUE\t/\tTRUE\t0\tsid\tnope",
      "#HttpOnly_.medium.com\tTRUE\t/\tTRUE\t0\tsid\t1:secret",
      ".medium.com\tTRUE\t/\tTRUE\t0\tuid\tabc123",
    ].join("\n");
    expect(extractSession(txt)).toEqual({ sid: "1:secret", uid: "abc123" });
  });

  it("accepts a bare sid value and rejects noise", () => {
    expect(extractSession("1:AbC-12_3")).toEqual({ sid: "1:AbC-12_3" });
    expect(extractSession("hello world")).toBeNull();
    expect(extractSession("")).toBeNull();
    expect(extractSession("uid=abc")).toBeNull();
  });
});

describe("credential storage", () => {
  const saved = { ...process.env };
  beforeEach(async () => {
    process.env.MEDIUM_READER_HOME = await mkdtemp(join(tmpdir(), "medium-reader-"));
    delete process.env.MEDIUM_SID;
    delete process.env.MEDIUM_UID;
    delete process.env.MEDIUM_COOKIE;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("round-trips through an owner-only file", async () => {
    await saveCredentials({ sid: "1:a", uid: "u" });
    expect((await stat(paths.auth)).mode & 0o777).toBe(0o600);
    expect(await loadCredentials()).toMatchObject({ sid: "1:a", uid: "u", source: "auth-file" });
  });

  it("prefers environment variables", async () => {
    await saveCredentials({ sid: "1:file", uid: "u" });
    process.env.MEDIUM_COOKIE = "sid=1:env; uid=envuid";
    expect(await loadCredentials()).toMatchObject({ sid: "1:env", uid: "envuid", source: "env" });
    process.env.MEDIUM_SID = "1:direct";
    process.env.MEDIUM_UID = "directuid";
    expect(await loadCredentials()).toMatchObject({ sid: "1:direct", uid: "directuid", source: "env" });
  });

  it("returns null when nothing is configured", async () => {
    expect(await loadCredentials()).toBeNull();
  });
});
