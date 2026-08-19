// What a delegator must be told about the pool they are in.
//
// Kept free of the wasm engine on purpose, so it can be tested directly: this
// is the safety-critical copy of the whole staking feature. Delegation is
// non-custodial by construction, so the chain already guarantees that a pool
// cannot take a delegator's coins. What it does NOT guarantee is that a pool
// pays anything at all, and the one protection there is a notice period before
// a payout policy can change. A notice period is worth exactly what the
// delegator notices, so these strings are the protection, not decoration.

/// Warnings for `record` (this wallet's delegation, or null) against `board`
/// (the pool board's feed, or null when it could not be read).
export function delegationWarnings(record, board) {
  if (!record) return [];
  const out = [];
  if (!record.confirmed) {
    out.push('This change has not confirmed yet. Until it does, your weight still counts for you.');
  }
  const pool = board && (board.pools || []).find((p) => p.signer === record.signer);
  if (!pool) {
    // Never imply that a missing board traps anyone: leaving needs only this
    // wallet's own key.
    out.push('This pool is not on the board right now, so what it has committed to cannot be shown. Leaving always works.');
    return out;
  }
  if (pool.declared === false) {
    // Delegating to a plain staker is allowed and the chain will not stop it,
    // but the wallet should not let anyone believe they joined a pool.
    out.push('This signer has not declared itself a pool: it has committed to no payout policy and never asked '
      + 'for delegations. It keeps everything its blocks earn, and nothing on-chain obliges it to pay you.');
  } else if (!pool.policy_in_force) {
    out.push('This pool has committed to no payout policy, so by default it keeps everything its blocks earn. Nothing on-chain obliges it to pay you.');
  } else if (pool.policy_in_force.mode === 'direct') {
    out.push('This pool pays a committed address. The chain stops it redirecting the reward silently, but does not check that address shares anything with you.');
  }
  for (const q of (pool.policy_pending || [])) {
    const when = new Date(Date.now() + q.blocks_away * (board.block_seconds || 60) * 1000);
    const commission = q.commission_bp === undefined ? '' : `, ${(q.commission_bp / 100).toFixed(2)}% commission`;
    out.push(`This pool has announced a NEW payout policy (${q.mode}${commission}) binding in `
      + `${q.blocks_away} blocks, around ${when.toLocaleString()}. If you do not accept it, leave before `
      + 'then: leaving is immediate and needs nobody\'s permission.');
  }
  if (pool.reliability !== undefined && pool.reliability < 0.5) {
    out.push('This pool has produced far fewer blocks than its weight is owed. While that lasts, your delegated weight is earning you nothing.');
  }
  return out;
}
