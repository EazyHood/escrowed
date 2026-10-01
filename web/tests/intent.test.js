import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentGuard, IntentChangedError } from '../src/lib/intent.js';
import { sendPrepared, DEVNET_GENESIS } from '../src/lib/chain.js';
import { PublicKey } from '@solana/web3.js';

const payer = new PublicKey(new Uint8Array(32).fill(7));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('editing the form during a pending simulation prevents its old preview from appearing', async () => {
  const guard = new IntentGuard();
  const intent = guard.begin();
  const simulation = deferred();
  let displayed = false;
  const preparation = (async () => { await simulation.promise; intent.assertCurrent(); displayed = true; })();
  guard.invalidate(); // The input/change handler has received a different amount.
  simulation.resolve();
  await assert.rejects(preparation, IntentChangedError);
  assert.equal(displayed, false);
});

test('a later operation replaces an earlier lookup even if responses arrive out of order', async () => {
  const guard = new IntentGuard();
  const older = guard.begin();
  const newer = guard.begin();
  newer.assertCurrent();
  assert.throws(() => older.assertCurrent(), IntentChangedError);
  guard.invalidate(); // A switch from Award to Verify cancels the remaining work.
  assert.throws(() => newer.assertCurrent(), IntentChangedError);
});

test('a changed intention while the signing boundary checks devnet never opens the wallet prompt', async () => {
  const guard = new IntentGuard(); const intent = guard.begin();
  const genesis = deferred();
  let signed = false;
  const provider = { publicKey: payer, signTransaction: async () => { signed = true; } };
  const prepared = { preparedAt: Date.now(), transaction: { feePayer: payer }, assertCurrent: intent.assertCurrent };
  const sending = sendPrepared({ getGenesisHash: () => genesis.promise }, provider, prepared);
  guard.invalidate(); genesis.resolve(DEVNET_GENESIS);
  await assert.rejects(sending, IntentChangedError);
  assert.equal(signed, false);
});

test('a wallet change while its approval is pending prevents the signed transaction from being broadcast', async () => {
  const guard = new IntentGuard(); const intent = guard.begin();
  const approval = deferred();
  let broadcast = false;
  const tx = { feePayer: payer, serializeMessage: () => new Uint8Array([1, 2, 3]) };
  const provider = { publicKey: payer, signTransaction: () => approval.promise };
  const connection = { getGenesisHash: async () => DEVNET_GENESIS, sendRawTransaction: async () => { broadcast = true; } };
  const prepared = { preparedAt: Date.now(), transaction: tx, assertCurrent: intent.assertCurrent };
  const signingStarted = deferred();
  const sending = sendPrepared(connection, provider, prepared, stage => { if (stage === 'signature') signingStarted.resolve(); });
  await signingStarted.promise;
  guard.invalidate(); approval.resolve(tx);
  await assert.rejects(sending, IntentChangedError);
  assert.equal(broadcast, false);
});
