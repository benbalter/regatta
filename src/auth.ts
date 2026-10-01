// Who may change repos or spend money, and who they are.
//
// Three ways in, checked in order:
// 1. Local dev against the fake Artifacts: open (nothing real to protect).
// 2. Cloudflare Access: a valid Cf-Access-Jwt-Assertion means a verified
//    identity, which is what gets recorded as the approver on landing merges.
// 3. The REGATTA_ADMIN_TOKEN bearer token, for API and MCP clients.
// Otherwise fail closed.

import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type Auth =
  | { ok: true; via: "dev" | "access" | "token"; identity: string | null }
  | { ok: false; status: 401 | 503; error: string };

const jwksByTeam = new Map<string, JWTVerifyGetKey>();
const jwksFor = (team: string) => {
  let jwks = jwksByTeam.get(team);
  if (!jwks) jwksByTeam.set(team, (jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`))));
  return jwks;
};

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `keys` exists for tests; production resolves the team's published Access certs. */
export async function authorize(env: Env, req: Request, keys?: JWTVerifyGetKey): Promise<Auth> {
  if (env.FAKE_ARTIFACTS_URL) return { ok: true, via: "dev", identity: null };

  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (jwt && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    try {
      const { payload } = await jwtVerify(jwt, keys ?? jwksFor(env.ACCESS_TEAM_DOMAIN), {
        issuer: env.ACCESS_TEAM_DOMAIN,
        audience: env.ACCESS_AUD,
      });
      const identity = typeof payload.email === "string" ? payload.email : typeof payload.sub === "string" ? payload.sub : null;
      return { ok: true, via: "access", identity };
    } catch {
      return { ok: false, status: 401, error: "Cloudflare Access token is invalid or expired" };
    }
  }

  const token = env.REGATTA_ADMIN_TOKEN;
  if (!token && !env.ACCESS_AUD) return { ok: false, status: 503, error: "no admin token or Cloudflare Access is configured" };
  const sent = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (token && sameSecret(sent, token)) return { ok: true, via: "token", identity: null };
  return { ok: false, status: 401, error: "sign in with Cloudflare Access or send Authorization: Bearer <REGATTA_ADMIN_TOKEN>" };
}

/** The approver to record: a verified Access identity beats whatever the client typed. */
export const approverFor = (auth: Auth, claimed: string | undefined) =>
  auth.ok && auth.via === "access" && auth.identity ? `${auth.identity} (verified by Cloudflare Access)` : claimed?.trim() || "a human reviewer";
