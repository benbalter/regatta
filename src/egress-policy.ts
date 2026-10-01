// What a sandbox may fetch from the internet, as a pure decision so it can be
// tested. Allowed hosts are read-only: GET and HEAD, plus the one POST git
// uses to *fetch* (git-upload-pack), for dependencies pinned to git sources.
// Nothing that could publish, push or post data out.

export function egressDecision(method: string, url: URL, allow: string[]): "allow" | string {
  if (!allow.includes(url.hostname)) return `${url.hostname} is not allowed`;
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return "allow";
  if (m === "POST" && url.pathname.endsWith("/git-upload-pack")) return "allow";
  return `${m} to ${url.hostname} is not allowed (sandboxes may only read)`;
}
