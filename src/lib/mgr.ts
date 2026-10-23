// Merry go round rotation: every month one member takes what the others contribute.
// A round ends once every active member has taken it once.

export interface RecipientMonth {
  period_id: string;
  seq: number;
  member_id: string;
}

/**
 * Numbers the rounds and works out who has already taken it in the current round.
 * `months` are the months that have a recipient, in any order.
 */
export function rotation(months: RecipientMonth[], activeMemberIds: string[]) {
  const sorted = [...months].sort((a, b) => a.seq - b.seq);
  const active = new Set(activeMemberIds);
  const roundOf = new Map<string, number>(); // period_id -> round number
  let round = 1;
  let taken = new Map<string, RecipientMonth>(); // member_id -> month taken, this round
  const complete = () => [...active].every((id) => taken.has(id));
  for (const m of sorted) {
    if (taken.has(m.member_id) || (taken.size > 0 && complete())) {
      round++;
      taken = new Map();
    }
    taken.set(m.member_id, m);
    roundOf.set(m.period_id, round);
  }
  if (taken.size > 0 && complete()) {
    round++;
    taken = new Map();
  }
  return { round, taken, roundOf };
}
