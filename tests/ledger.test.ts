import { test } from "node:test";
import assert from "node:assert/strict";
import { autoSplit, computeEntry, expectedAmount, interestDue, interestOn, splitBonus, type Openings } from "../src/lib/ledger";
import { rotation } from "../src/lib/mgr";
import { parseMoney, formatMoney, parsePercent, formatPercent, centsToInput } from "../src/lib/money";

const open = (o: Partial<Openings> = {}): Openings => ({
  savings_open: 0, advance_bal_open: 0, advance_interest_bf: 0, advance_interest_charged: 0, bonus_credit: 0, ...o,
});
/** Fed values; interest due starts as what the roll worked out for `o`, as on the sheet. */
const inp = (o: Openings, m: Partial<Record<string, number>> = {}) => ({
  amount_paid: 0, advance_repaid: 0, advance_issued: 0, mgr_contribution: 0, fine_paid: 0, advance_interest_due: interestDue(o), ...m,
});

test("money parsing never uses floats", () => {
  assert.equal(parseMoney("0.1"), 10);
  assert.equal(parseMoney("0.2"), 20);
  assert.equal(parseMoney("1,234.56"), 123456);
  assert.equal(parseMoney("KES 500"), 50000);
  assert.equal(parseMoney(""), 0);
  assert.equal(parseMoney("1.005"), null);
  assert.equal(parseMoney("-5"), null);
  assert.equal(parseMoney("abc"), null);
  assert.equal(parseMoney("19.99"), 1999); // 19.99*100 = 1998.9999999999998 in floats
  assert.equal(formatMoney(123456789), "1,234,567.89");
  assert.equal(formatMoney(5), "0.05");
  assert.equal(formatMoney(-150), "-1.50");
  assert.equal(centsToInput(150000), "1500");
  assert.equal(centsToInput(150050), "1500.50");
  assert.equal(parsePercent("10"), 1000);
  assert.equal(parsePercent("12.5%"), 1250);
  assert.equal(parsePercent("101"), null);
  assert.equal(formatPercent(1250), "12.5");
  assert.equal(formatPercent(1000), "10");
});

test("10% interest rounds half-up to the cent", () => {
  assert.equal(interestOn(1000000, 1000), 100000); // 10,000 -> 1,000
  assert.equal(interestOn(5, 1000), 1);            // 0.05 -> 0.005 -> 0.01
  assert.equal(interestOn(4, 1000), 0);
  assert.equal(interestOn(0, 1000), 0);
  assert.equal(interestOn(9_000_000_000_000, 1000), 900_000_000_000);
});

const T = { advance_rate_bps: 1000, mgr_due: 100000 };

test("bringing what is expected pays interest, the advance and the merry go round; the rest is savings", () => {
  const o = open({ advance_bal_open: 1000000, advance_interest_charged: 100000, savings_open: 500000 });
  assert.equal(expectedAmount(o, interestDue(o), T.mgr_due), 1200000);
  const split = autoSplit(o, 1500000, interestDue(o), T.mgr_due);
  assert.deepEqual(split, { advance_repaid: 1000000, mgr_contribution: 100000 });
  const { computed, errors } = computeEntry(o, inp(o, { amount_paid: 1500000, ...split }), T);
  assert.deepEqual(errors, []);
  assert.equal(computed.advance_interest_paid, 100000);
  assert.equal(computed.savings_contribution, 300000);
  assert.equal(computed.advance_bal_close, 0);
  assert.equal(computed.savings_close, 800000);
  assert.equal(computed.advance_interest_arrears, 0);
});

test("exactly the expected amount is enough", () => {
  const o = open({ advance_bal_open: 100000 });
  assert.deepEqual(autoSplit(o, 200000, interestDue(o), T.mgr_due), { advance_repaid: 100000, mgr_contribution: 100000 });
  assert.deepEqual(autoSplit(o, 199999, interestDue(o), T.mgr_due), { advance_repaid: 0, mgr_contribution: 0 });
});

test("bringing less than expected all goes to savings and the interest is carried", () => {
  const o = open({ advance_bal_open: 100000, advance_interest_charged: 10000 });
  const split = autoSplit(o, 150000, interestDue(o), T.mgr_due);
  assert.deepEqual(split, { advance_repaid: 0, mgr_contribution: 0 });
  const { computed, errors } = computeEntry(o, inp(o, { amount_paid: 150000, ...split }), T);
  assert.deepEqual(errors, []);
  assert.equal(computed.advance_interest_paid, 0);
  assert.equal(computed.savings_contribution, 150000);
  assert.equal(computed.advance_interest_arrears, 10000);
  assert.equal(computed.advance_bal_close, 100000);
});

test("the chairman can change the split; a repayment always pays the interest first", () => {
  const o = open({ advance_bal_open: 100000, advance_interest_charged: 10000 });
  // short, but part of the advance is repaid: interest comes out first
  const part = computeEntry(o, inp(o, { amount_paid: 60000, advance_repaid: 50000 }), T);
  assert.deepEqual(part.errors, []);
  assert.equal(part.computed.advance_interest_paid, 10000);
  assert.equal(part.computed.savings_contribution, 0);
  const bad = computeEntry(o, inp(o, { amount_paid: 55000, advance_repaid: 50000 }), T);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /Short by 50.00/);
  // covered, but the chairman takes less merry go round: the difference is savings
  const less = computeEntry(o, inp(o, { amount_paid: 300000, advance_repaid: 100000, mgr_contribution: 50000 }), T);
  assert.deepEqual(less.errors, []);
  assert.equal(less.computed.savings_contribution, 140000);
});

test("with no merry go round amount set, only the interest and advance are expected", () => {
  const o = open({ advance_bal_open: 100000 });
  assert.equal(expectedAmount(o, interestDue(o), 0), 100000);
  assert.deepEqual(autoSplit(o, 100000, interestDue(o), 0), { advance_repaid: 100000, mgr_contribution: 0 });
});

test("a fine is only what the chairman feeds, and is not part of what is expected", () => {
  const o = open({ advance_bal_open: 100000, advance_interest_charged: 10000 });
  // nothing about a fine in what is expected or in the auto split
  assert.equal(expectedAmount(o, interestDue(o), T.mgr_due), 210000);
  const split = autoSplit(o, 300000, interestDue(o), T.mgr_due);
  assert.deepEqual(split, { advance_repaid: 100000, mgr_contribution: 100000 });
  // fed: it comes out of the amount brought, before savings
  const fined = computeEntry(o, inp(o, { amount_paid: 300000, ...split, fine_paid: 2000 }), T);
  assert.deepEqual(fined.errors, []);
  assert.equal(fined.computed.advance_interest_paid, 10000);
  assert.equal(fined.computed.savings_contribution, 88000);
  // bringing exactly what is expected still pays the interest; a fine on top is short
  const exact = computeEntry(o, inp(o, { amount_paid: 210000, ...autoSplit(o, 210000, interestDue(o), T.mgr_due), fine_paid: 2000 }), T);
  assert.match(exact.errors[0], /fine \(20.00\)\. Short by 20.00/);
  // a member who brings less than expected can still be fined out of their money
  const short = computeEntry(o, inp(o, { amount_paid: 50000, fine_paid: 2000 }), T);
  assert.deepEqual(short.errors, []);
  assert.equal(short.computed.savings_contribution, 48000);
  assert.equal(short.computed.advance_interest_arrears, 10000);
});

test("cannot repay more than the balance", () => {
  const o = open({ advance_bal_open: 1000 });
  const r = computeEntry(o, inp(o, { amount_paid: 5000, advance_repaid: 2000 }), T);
  assert.equal(r.errors.length, 1);
});

test("interest is cut from a new advance, the whole advance is owed", () => {
  const r = computeEntry(open(), inp(open(), { amount_paid: 50000, advance_issued: 100000 }), T);
  assert.deepEqual(r.errors, []);
  assert.equal(r.computed.advance_interest_deducted, 10000); // takes 1,000, is handed 900
  assert.equal(r.computed.advance_bal_close, 100000);        // owes 1,000 next month
  assert.equal(r.computed.savings_contribution, 50000);
});

test("the chairman can change the interest due", () => {
  const o = open({ advance_bal_open: 100000, advance_interest_bf: 5000, advance_interest_charged: 10000 });
  assert.equal(interestDue(o), 15000);
  // lowered to 4,000: that is what is expected and collected, nothing is carried
  assert.equal(expectedAmount(o, 4000, 0), 104000);
  const low = computeEntry(o, inp(o, { advance_interest_due: 4000, amount_paid: 104000, ...autoSplit(o, 104000, 4000, 0) }), { ...T, mgr_due: 0 });
  assert.deepEqual(low.errors, []);
  assert.equal(low.computed.advance_interest_paid, 4000);
  assert.equal(low.computed.advance_interest_arrears, 0);
  assert.equal(low.computed.advance_bal_close, 0);
  // raised and not paid: the whole raised amount is carried forward
  const high = computeEntry(o, inp(o, { advance_interest_due: 20000, amount_paid: 1000 }), T);
  assert.deepEqual(high.errors, []);
  assert.equal(high.computed.advance_interest_arrears, 20000);
  assert.equal(high.computed.savings_contribution, 1000);
});

test("identities hold for many random entries", () => {
  let seed = 42;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 20000; i++) {
    const adv = rnd(1_000_000);
    const o = open({ savings_open: rnd(9_000_000), advance_bal_open: adv,
      advance_interest_bf: rnd(3) ? 0 : rnd(50_000), advance_interest_charged: rnd(2) ? 0 : interestOn(adv, 1000),
      bonus_credit: rnd(4) ? 0 : rnd(10_000) });
    const t = { advance_rate_bps: 1000, mgr_due: rnd(3) ? 100000 : 0 };
    const paid = rnd(2_000_000);
    const due = rnd(3) ? interestDue(o) : rnd(80_000); // sometimes changed by the chairman
    const m = rnd(2)
      ? inp(o, { amount_paid: paid, advance_interest_due: due, ...autoSplit(o, paid, due, t.mgr_due), advance_issued: rnd(5) ? 0 : rnd(5_000_000) })
      : inp(o, { amount_paid: paid, advance_interest_due: due, advance_repaid: rnd(2) ? 0 : rnd(adv + 1),
          advance_issued: rnd(5) ? 0 : rnd(5_000_000), mgr_contribution: rnd(2) ? 0 : rnd(500_000), fine_paid: rnd(2) ? 0 : rnd(5_000) });
    const { computed: c, errors } = computeEntry(o, m, t);
    if (m.advance_repaid === 0 && m.mgr_contribution === 0 && m.fine_paid === 0) assert.deepEqual(errors, []);
    if (errors.length) continue;
    assert.equal(m.amount_paid, c.advance_interest_paid + m.advance_repaid + m.mgr_contribution + m.fine_paid + c.savings_contribution);
    assert.equal(c.savings_close, o.savings_open + c.savings_contribution + o.bonus_credit);
    assert.equal(c.advance_bal_close, o.advance_bal_open + m.advance_issued - m.advance_repaid);
    assert.equal(c.advance_interest_arrears + c.advance_interest_paid, m.advance_interest_due);
    assert.ok(m.advance_repaid === 0 || c.advance_interest_arrears === 0);
    assert.ok(c.advance_interest_deducted <= m.advance_issued);
    for (const v of Object.values(c)) assert.ok(Number.isSafeInteger(v) && v >= 0);
  }
});

test("merry go round rounds", () => {
  const m = (seq: number, member_id: string) => ({ period_id: `p${seq}`, seq, member_id });
  const ids = ["a", "b", "c"];
  const r1 = rotation([m(2, "b"), m(1, "a")], ids);
  assert.equal(r1.round, 1);
  assert.deepEqual([...r1.taken.keys()], ["a", "b"]);
  const r2 = rotation([m(1, "a"), m(2, "b"), m(3, "c")], ids);
  assert.equal(r2.round, 2);
  assert.equal(r2.taken.size, 0);
  const r3 = rotation([m(1, "a"), m(2, "b"), m(3, "c"), m(4, "b")], ids);
  assert.equal(r3.round, 2);
  assert.equal(r3.roundOf.get("p4"), 2);
  assert.equal(r3.roundOf.get("p3"), 1);
});

test("bonus shares always add up exactly", () => {
  const members = [
    { member_id: "a", member_no: 1, weight: 333333 },
    { member_id: "b", member_no: 2, weight: 333333 },
    { member_id: "c", member_no: 3, weight: 333334 },
  ];
  for (const total of [1, 2, 100, 100001, 999999, 12345678]) {
    const s = splitBonus(total, members);
    assert.equal(s.reduce((a, x) => a + x.amount, 0), total);
  }
  const eq = splitBonus(1000, members.map((m) => ({ ...m, weight: 0 })));
  assert.deepEqual(eq.map((x) => x.amount), [334, 333, 333]);
  const prop = splitBonus(10000, [
    { member_id: "a", member_no: 1, weight: 300 },
    { member_id: "b", member_no: 2, weight: 100 },
  ]);
  assert.deepEqual(prop.map((x) => x.amount), [7500, 2500]);
});
