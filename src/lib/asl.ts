/** Amazon States Language helpers shared by the UI and tests. */
type Transitions = { Type?: string; Next?: string; Default?: string; Choices?: { Next?: string }[]; Catch?: { Next?: string }[] };
type Machine = { StartAt?: string; States?: Record<string, Transitions> };

/** Order states by following transitions from StartAt, then append any unreachable ones. */
export function orderStates(m: Machine): string[] {
  const states = m.States ?? {};
  const seen: string[] = [];
  const visit = (n?: string) => {
    if (!n || seen.includes(n) || !states[n]) return;
    seen.push(n);
    const s = states[n];
    visit(s.Next);
    for (const c of s.Choices ?? []) visit(c.Next);
    visit(s.Default);
    for (const c of s.Catch ?? []) visit(c.Next);
  };
  visit(m.StartAt);
  for (const n of Object.keys(states)) if (!seen.includes(n)) seen.push(n);
  return seen;
}

