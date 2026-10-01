// The *why* travels with the commit. Git trailers survive clones, forks and
// merges, so anyone reading `git log` later sees the campaign intent and the
// agent's reasoning without needing Regatta.

export interface RegattaTrailers {
  campaign: string;
  attempt: string;
  intent: string;
  problem: string;
  alternatives: string;
  rationale: string;
  /** Land (merge) commits only: the decision a human or policy made. */
  decision?: string;
  approvedBy?: string;
  dissent?: string;
  dissentResponse?: string;
}

const KEYS: Array<[keyof RegattaTrailers, string]> = [
  ["campaign", "Regatta-Campaign"],
  ["attempt", "Regatta-Attempt"],
  ["intent", "Regatta-Intent"],
  ["problem", "Regatta-Problem"],
  ["alternatives", "Regatta-Alternatives"],
  ["rationale", "Regatta-Rationale"],
  ["decision", "Regatta-Decision"],
  ["approvedBy", "Regatta-Approved-By"],
  ["dissent", "Regatta-Dissent"],
  ["dissentResponse", "Regatta-Dissent-Response"],
];

// Trailer values may continue onto following lines when indented, per git-interpret-trailers.
export function trailers(t: Partial<RegattaTrailers>): string {
  return KEYS.filter(([k]) => t[k]?.trim())
    .map(([k, name]) => `${name}: ${t[k]!.trim().split("\n").join("\n ")}`)
    .join("\n");
}

export function parseTrailers(message: string): Partial<RegattaTrailers> {
  const out: Partial<RegattaTrailers> = {};
  const lines = message.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const hit = KEYS.find(([, name]) => lines[i].startsWith(`${name}: `));
    if (!hit) continue;
    let value = lines[i].slice(hit[1].length + 2);
    while (lines[i + 1]?.startsWith(" ")) value += `\n${lines[++i].slice(1)}`;
    out[hit[0]] = value;
  }
  return out;
}
