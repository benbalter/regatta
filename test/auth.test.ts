import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { approverFor, authorize } from "../src/auth";

const TEAM = "https://regatta.cloudflareaccess.com";
const AUD = "aud-tag-123";
let keys: ReturnType<typeof createLocalJWKSet>;
let sign: (claims: Record<string, unknown>, opts?: { aud?: string; iss?: string }) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? TEAM)
      .setAudience(opts.aud ?? AUD)
      .setExpirationTime("5m")
      .sign(privateKey);
});

const req = (headers: Record<string, string> = {}) => new Request("https://regatta.example/api/races", { method: "POST", headers });
const prod = { REGATTA_ADMIN_TOKEN: "s3cret", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as Env;

describe("authorize", () => {
  it("is open only in local dev against the fake Artifacts", async () => {
    expect(await authorize({ FAKE_ARTIFACTS_URL: "http://localhost:8790" } as Env, req())).toMatchObject({ ok: true, via: "dev" });
  });

  it("accepts a valid Cloudflare Access token and reports the verified identity", async () => {
    const jwt = await sign({ email: "ben@example.com" });
    expect(await authorize(prod, req({ "cf-access-jwt-assertion": jwt }), keys)).toEqual({ ok: true, via: "access", identity: "ben@example.com" });
  });

  it("rejects an Access token for another application or issuer", async () => {
    for (const opts of [{ aud: "someone-else" }, { iss: "https://evil.cloudflareaccess.com" }]) {
      const jwt = await sign({ email: "ben@example.com" }, opts);
      expect(await authorize(prod, req({ "cf-access-jwt-assertion": jwt }), keys)).toMatchObject({ ok: false, status: 401 });
    }
  });

  it("accepts the bearer token and rejects a wrong one", async () => {
    expect(await authorize(prod, req({ authorization: "Bearer s3cret" }))).toMatchObject({ ok: true, via: "token" });
    expect(await authorize(prod, req({ authorization: "Bearer s3cre7" }))).toMatchObject({ ok: false, status: 401 });
    expect(await authorize(prod, req())).toMatchObject({ ok: false, status: 401 });
  });

  it("fails closed when nothing is configured", async () => {
    expect(await authorize({} as Env, req({ authorization: "Bearer anything" }))).toMatchObject({ ok: false, status: 503 });
  });
});

describe("approverFor", () => {
  it("records a verified Access identity over whatever the client claimed", () => {
    expect(approverFor({ ok: true, via: "access", identity: "ben@example.com" }, "mallory")).toBe("ben@example.com (verified by Cloudflare Access)");
    expect(approverFor({ ok: true, via: "token", identity: null }, "ben")).toBe("ben");
    expect(approverFor({ ok: true, via: "dev", identity: null }, undefined)).toBe("a human reviewer");
  });
});
