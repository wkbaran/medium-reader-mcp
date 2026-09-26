import { describe, expect, it } from "vitest";
import { AuthError, BlockedError, MediumError, MediumHttp } from "../src/medium/http.js";
import { fakeMedium, SESSION } from "./helpers.js";

const noSleep = async () => undefined;

describe("MediumHttp", () => {
  it("sends both session cookies and a browser User-Agent", async () => {
    const { fetch, requests } = fakeMedium({ V: { data: { viewer: { id: "x" } } } });
    await new MediumHttp({ session: SESSION, fetch }).gql("query V { viewer { id } }");
    expect(requests[0]!.cookie).toBe(`sid=${SESSION.sid}; uid=${SESSION.uid}`);
    expect(requests[0]!.headers.get("user-agent")).toMatch(/Chrome\/\d+/);
    expect(requests[0]!.headers.get("user-agent")).not.toMatch(/Headless/);
    expect(requests[0]!.operationName).toBe("V");
  });

  it("sends no cookie without a session and refuses auth-only calls", async () => {
    const { fetch, requests } = fakeMedium({ V: { data: { viewer: null } } });
    const http = new MediumHttp({ fetch });
    await http.gql("query V { viewer { id } }");
    expect(requests[0]!.cookie).toBeNull();
    await expect(http.gql("query V { viewer { id } }", {}, { requireAuth: true })).rejects.toBeInstanceOf(AuthError);
    expect(requests).toHaveLength(1);
  });

  it("reports Cloudflare's challenge page as BlockedError", async () => {
    const { fetch } = fakeMedium({ V: { status: 403, raw: "<!DOCTYPE html><title>Attention Required! | Cloudflare</title>" } });
    await expect(new MediumHttp({ fetch }).gql("query V { viewer { id } }")).rejects.toBeInstanceOf(BlockedError);
  });

  it("turns GraphQL errors into MediumError but keeps partial data", async () => {
    const { fetch } = fakeMedium({
      Bad: { errors: [{ message: 'Cannot query field "nope"' }] },
      Partial: { data: { post: { id: "1" }, other: null }, errors: [{ message: "other failed" }] },
    });
    const http = new MediumHttp({ fetch });
    await expect(http.gql("query Bad { nope }")).rejects.toThrow(/Cannot query field "nope"/);
    await expect(http.gql("query Partial { post { id } other }")).resolves.toEqual({ post: { id: "1" }, other: null });
  });

  it("retries queries on 429/5xx but never retries a mutation", async () => {
    let queries = 0;
    let mutations = 0;
    const { fetch } = fakeMedium({
      Q: () => (++queries < 3 ? { status: 503, raw: "busy" } : { data: { ok: true } }),
      M: () => {
        mutations++;
        return { status: 502, raw: "bad gateway" };
      },
    });
    const http = new MediumHttp({ session: SESSION, fetch, sleep: noSleep });
    await expect(http.gql("query Q { ok }")).resolves.toEqual({ ok: true });
    expect(queries).toBe(3);
    await expect(http.gql("mutation M { clap }")).rejects.toBeInstanceOf(MediumError);
    expect(mutations).toBe(1);
  });

  it("maps 401 to an expired session when one was sent", async () => {
    const { fetch } = fakeMedium({ V: { status: 401, raw: "{}" } });
    const err = await new MediumHttp({ session: SESSION, fetch }).gql("query V { viewer { id } }").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).reason).toBe("expired");
  });
});
