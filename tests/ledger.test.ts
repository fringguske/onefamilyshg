import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEntry, interestOn, splitBonus, type Openings } from "../src/lib/ledger";
import { rotation } from "../src/lib/mgr";
import { parseMoney, formatMoney, parsePercent, formatPercent, centsToInput } from "../src/lib/money";

const open = (o: Partial<Openings> = {}): Openings => ({
  savings_open: 0, advance_bal_open: 0, advance_interest_bf: 0, advance_interest_charged: 0, bonus_credit: 0, ...o,
});
const inp = (m: Partial<Record<string, number>> = {}) => ({
  amount_paid: 0, advance_repaid: 0, advance_issued: 0, mgr_contribution: 0, ...m,
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

test("interest is deducted first, the rest becomes savings", () => {
  const o = open({ advance_bal_open: 1000000, advance_interest_charged: 100000, savings_open: 500000 });
  const { computed, errors } = computeEntry(o, inp({ amount_paid: 500000, advance_repaid: 200000 }));
  assert.deepEqual(errors, []);
  assert.equal(computed.advance_interest_paid, 100000);
  assert.equal(computed.savings_contribution, 200000);
  assert.equal(computed.advance_bal_close, 800000);
  assert.equal(computed.savings_close, 700000);
  assert.equal(computed.advance_interest_arrears, 0);
});

test("short payment carries interest arrears and blocks repayments", () => {
  const o = open({ advance_bal_open: 100000, advance_interest_charged: 10000 });
  const ok = computeEntry(o, inp({ amount_paid: 4000 }));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.computed.advance_interest_arrears, 6000);
  const bad = computeEntry(o, inp({ amount_paid: 4000, advance_repaid: 1000 }));
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /Short by 70.00/);
});

test("cannot repay more than the balance", () => {
  const r = computeEntry(open({ advance_bal_open: 1000 }), inp({ amount_paid: 5000, advance_repaid: 2000 }));
  assert.equal(r.errors.length, 1);
});

test("new advances add to the balance", () => {
  const r = computeEntry(open(), inp({ amount_paid: 100000, advance_issued: 500000 }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.computed.advance_bal_close, 500000);
  assert.equal(r.computed.savings_contribution, 100000);
});

test("merry go round contribution does not touch savings or interest", () => {
  const o = open({ savings_open: 100000, advance_bal_open: 50000, advance_interest_charged: 5000 });
  const a = computeEntry(o, inp({ amount_paid: 20000 }));
  const b = computeEntry(o, inp({ amount_paid: 20000, mgr_contribution: 100000 }));
  assert.deepEqual(b.errors, []);
  assert.deepEqual(b.computed, a.computed);
});

test("identities hold for many random entries", () => {
  let seed = 42;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 20000; i++) {
    const adv = rnd(1_000_000);
    const o = open({ savings_open: rnd(9_000_000), advance_bal_open: adv,
      advance_interest_bf: rnd(3) ? 0 : rnd(50_000), advance_interest_charged: interestOn(adv, 1000),
      bonus_credit: rnd(4) ? 0 : rnd(10_000) });
    const m = inp({ amount_paid: rnd(2_000_000), advance_repaid: rnd(2) ? 0 : rnd(adv + 1),
      advance_issued: rnd(5) ? 0 : rnd(5_000_000), mgr_contribution: rnd(2) ? 0 : rnd(500_000) });
    const { computed: c, errors } = computeEntry(o, m);
    if (errors.length) continue;
    assert.equal(m.amount_paid, c.advance_interest_paid + m.advance_repaid + c.savings_contribution);
    assert.equal(c.savings_close, o.savings_open + c.savings_contribution + o.bonus_credit);
    assert.equal(c.advance_bal_close, o.advance_bal_open + m.advance_issued - m.advance_repaid);
    assert.equal(c.advance_interest_arrears + c.advance_interest_paid, o.advance_interest_bf + o.advance_interest_charged);
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
