import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleRead, normaliseGroup, ruleFlags } from '../server/forward.js';
import { liveStatus, canGive, MONEY_RE } from '../server/shared.js';

test('normalises blood group spellings', () => {
  assert.equal(normaliseGroup('B -ve'), 'B-');
  assert.equal(normaliseGroup('o positive'), 'O+');
  assert.equal(normaliseGroup('AB+'), 'AB+');
  assert.equal(normaliseGroup('xyz'), null);
});

test('reads a typical forward', () => {
  const t = 'URGENT!! B -ve blood needed 3 units at Apollo Hospital Greams Road for my father. Contact 98400 12345. Pls share to all groups';
  const f = ruleRead(t);
  assert.equal(f.bloodGroup, 'B-');
  assert.equal(f.units, 3);
  assert.match(f.hospital, /Apollo Hospital/);
  assert.equal(f.phone, '9840012345');
  const flags = ruleFlags(t, f);
  assert.ok(flags.includes('no date in the message'));
  assert.ok(flags.some((x) => /forward/.test(x)));
});

test('live status: open, fulfilled, expired', () => {
  const base = { units: '3', arranged: '1', pledged: '2', neededBy: String(Date.now() + 3600e3), status: 'open' };
  assert.equal(liveStatus(base).state, 'open');
  assert.equal(liveStatus(base).line, '1 of 3 units arranged');
  assert.equal(liveStatus({ ...base, status: 'fulfilled' }).state, 'fulfilled');
  assert.equal(liveStatus({ ...base, neededBy: '1' }).state, 'expired');
});

test('donor compatibility', () => {
  assert.ok(canGive('O-', 'AB+'));
  assert.ok(!canGive('A+', 'O+'));
  assert.ok(canGive('B-', 'B+'));
});

test('money guard catches fee asks', () => {
  assert.ok(MONEY_RE.test('please send Rs 200 travel fee on GPay'));
  assert.ok(MONEY_RE.test('Pay convenience fee first'));
  assert.ok(!MONEY_RE.test('I will reach the blood bank at 6 pm'));
});

test('server module loads and starts', async () => {
  const { spawn } = await import('node:child_process');
  const p = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: '3987' } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  await new Promise((r) => setTimeout(r, 1500));
  p.kill();
  assert.match(out, /Redsure on :3987/);
});

test('money guard: amount before currency, registration fee', () => {
  assert.ok(MONEY_RE.test('Send 500 rs registration fee'));
  assert.ok(!MONEY_RE.test('Please come to the blood bank by 6 pm.'));
  assert.ok(!MONEY_RE.test('Hi Priya, I can donate for your B- request at Government General Hospital. When and where should I come?'));
});
