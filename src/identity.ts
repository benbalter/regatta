// Repo identity comes from where the code lives, never from a name someone
// typed. Two targets with the same display name but different URLs must not
// share a base repo (and with it, claims, the `why` cache and the dependency
// cache namespace); two spellings of the same URL must.

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Lowercase host, no credentials/query/fragment, no trailing slash or `.git`. */
export function canonicalRepoUrl(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  return `${u.protocol}//${u.host.toLowerCase()}${path}`;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable, collision-resistant Artifacts name for a target's base repo. */
export async function baseRepoName(url: string, branch?: string): Promise<string> {
  const canonical = canonicalRepoUrl(url);
  const hash = (await sha256Hex(`${canonical}#${branch ?? ""}`)).slice(0, 12);
  const readable = slug(canonical.split("/").at(-1) ?? "repo").slice(0, 40) || "repo";
  return `base-${readable}-${hash}`;
}
