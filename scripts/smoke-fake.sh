#!/usr/bin/env bash
# Exercises the fake Artifacts server end to end: import, fork, token, push, log, auth.
set -euo pipefail
B=${FAKE:-http://localhost:8790}
W=$(mktemp -d)
# Isolate from the developer's git config (identity, signing): these are throwaway commits.
export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@localhost \
  GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@localhost
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
curl -s -XPOST $B/repos/import -d '{"source":{"url":"https://github.com/benbalter/jekyll-titles-from-headings"},"target":{"name":"jtfh"}}' | j '"import:", d["success"], d["result"]["remote"]'
curl -s $B/repos/jtfh/log | j '"early log (expect 10302):", d["errors"][0]["code"]'
until [ "$(curl -s $B/repos/jtfh | j 'd["result"]["status"]')" = ready ]; do sleep 0.5; done
curl -s $B/repos/jtfh | j '"ready, default branch:", d["result"]["defaultBranch"]'
curl -s -XPOST $B/repos/jtfh/fork -d '{"name":"jtfh-a1"}' >/dev/null
until [ "$(curl -s $B/repos/jtfh-a1 | j 'd["result"]["status"]')" = ready ]; do sleep 0.5; done
TOK=$(curl -s -XPOST $B/repos/jtfh-a1/tokens -d '{"scope":"write","ttl":600}' | j 'd["result"]["plaintext"].split("?")[0]')
git clone -q "http://x:$TOK@localhost:8790/git/jtfh-a1.git" $W/c
cd $W/c && echo hi >> README.md && git commit -qam $'smoke push\n\nRegatta-Intent: smoke' && git push -q origin HEAD && echo "push: ok"
curl -s "$B/repos/jtfh-a1/log?limit=1" | j '"fork head:", d["result"][0]["message"].splitlines()[0]'
curl -s "$B/repos/jtfh/log?limit=1" | j '"source head unchanged:", d["result"][0]["message"].splitlines()[0]'
RTOK=$(curl -s -XPOST $B/repos/jtfh-a1/tokens -d '{"scope":"read"}' | j 'd["result"]["plaintext"].split("?")[0]')
git push -q "http://x:$RTOK@localhost:8790/git/jtfh-a1.git" HEAD:refs/heads/x 2>/dev/null && echo "FAIL read token pushed" || echo "read token push: rejected"
curl -s -XDELETE "$B/repos/jtfh-a1/tokens/$TOK" | j '"revoke:", d["result"]'
git fetch -q "http://x:$TOK@localhost:8790/git/jtfh-a1.git" 2>/dev/null && echo "FAIL revoked token works" || echo "revoked token: rejected"
curl -s "$B/repos/jtfh/file?ref=HEAD&path=README.md" | j '"readFile:", d["result"]["content"][:30].strip()'
rm -rf $W
