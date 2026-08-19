// The delegator's warnings ARE the protection, so they are tested like code.
//
// Delegation is non-custodial by construction: the chain guarantees a pool
// cannot take a delegator's coins, and that leaving needs nobody's cooperation.
// What the chain does NOT guarantee is that a pool pays anything, and the only
// safeguard there is a notice period before a payout policy can change. A notice
// period is worth exactly what the delegator notices. If one of these strings
// stops appearing, nothing breaks and nothing errors: someone simply is not
// told, which is the failure that matters most here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { delegationWarnings } from '../src/staking-warnings.js';

const SIGNER = '02' + 'ab'.repeat(32);
const record = (over = {}) => ({ signer: SIGNER, confirmed: true, ...over });
const board = (pool = {}) => ({
  block_seconds: 60,
  pools: [{
    signer: SIGNER, weight: 1, delegators: 1, network_share: 0.1,
    eligible: true, committee_ready: true, policy_pending: [], ...pool,
  }],
});

test('not delegating produces no warnings at all', () => {
  assert.deepEqual(delegationWarnings(null, board()), []);
});

test('a pool that has committed to nothing says so', () => {
  const w = delegationWarnings(record(), board({ policy_in_force: undefined }));
  assert.ok(w.some((s) => s.includes('keeps everything its blocks earn')),
    'the honest default must be stated, not left blank');
  assert.ok(w.some((s) => s.includes('Nothing on-chain obliges it to pay you')));
});

test('direct mode does not claim a fairness the chain does not enforce', () => {
  const w = delegationWarnings(record(), board({ policy_in_force: { mode: 'direct', activation: 1 } }));
  assert.ok(w.some((s) => s.includes('does not check that address shares anything with you')));
});

test('a lottery policy in force is not warned about', () => {
  const w = delegationWarnings(record(),
    board({ policy_in_force: { mode: 'lottery', activation: 1, commission_bp: 500 } }));
  assert.deepEqual(w, [], 'a committed, proportional policy needs no warning');
});

test('an announced change is reported with its deadline and how to act', () => {
  const w = delegationWarnings(record(), board({
    policy_in_force: { mode: 'lottery', activation: 1, commission_bp: 0 },
    policy_pending: [{ mode: 'lottery', activation: 9000, commission_bp: 2500, blocks_away: 1440 }],
  }));
  const notice = w.find((s) => s.includes('announced a NEW payout policy'));
  assert.ok(notice, 'the notice period is worthless if the notice is not shown');
  assert.ok(notice.includes('25.00% commission'), 'the new terms must be spelled out');
  assert.ok(notice.includes('1440 blocks'), 'how long is left to act');
  assert.ok(notice.includes('leaving is immediate'), 'and that acting is possible');
});

test('every pending change is reported, not just the first', () => {
  const w = delegationWarnings(record(), board({
    policy_in_force: { mode: 'lottery', activation: 1, commission_bp: 0 },
    policy_pending: [
      { mode: 'lottery', activation: 9000, commission_bp: 1000, blocks_away: 100 },
      { mode: 'direct', activation: 9500, blocks_away: 600 },
    ],
  }));
  assert.equal(w.filter((s) => s.includes('announced a NEW payout policy')).length, 2);
});

test('a pool producing far below its share is flagged', () => {
  const w = delegationWarnings(record(), board({
    policy_in_force: { mode: 'lottery', activation: 1, commission_bp: 0 }, reliability: 0.1,
  }));
  assert.ok(w.some((s) => s.includes('earning you nothing')));
});

test('a pool merely a little under target is not flagged', () => {
  const w = delegationWarnings(record(), board({
    policy_in_force: { mode: 'lottery', activation: 1, commission_bp: 0 }, reliability: 0.9,
  }));
  assert.deepEqual(w, [], 'normal variance must not cry wolf');
});

test('an unconfirmed change says the weight still counts for you', () => {
  const w = delegationWarnings(record({ confirmed: false }),
    board({ policy_in_force: { mode: 'lottery', activation: 1, commission_bp: 0 } }));
  assert.ok(w.some((s) => s.includes('still counts for you')));
});

test('an unreachable board never implies you are stuck', () => {
  const w = delegationWarnings(record(), null);
  assert.equal(w.length, 1);
  assert.ok(w[0].includes('Leaving always works'),
    'leaving needs only this wallet\'s own key, and the copy must not suggest otherwise');
});

test('a pool missing from the board is treated the same way', () => {
  const w = delegationWarnings(record(), { block_seconds: 60, pools: [] });
  assert.ok(w[0].includes('Leaving always works'));
});
