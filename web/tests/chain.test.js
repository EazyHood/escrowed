import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  PROGRAM_ID, DEVNET_GENESIS, ACCOUNT_SIZE, validateListing, deriveEscrow,
  parseSol, formatSol, parseDeadline, discriminator, decodeEscrow, verifyAccount,
  createInstruction, awardInstruction, refundInstruction, assertDevnet, inspectEscrow,
  prepareTransaction, sendPrepared, explorerAddress, explorerTransaction, publicKey,
} from '../src/lib/chain.js';

const sponsor = new PublicKey(new Uint8Array(32).fill(7));
const winner = new PublicKey(new Uint8Array(32).fill(9));
const listing = 'https://example.com/bounties/test?case=One';
const rent = 1_740_000;
const amount = 10_000_000n;

async function fixture(status = 0) {
  const derived = await deriveEscrow(listing, sponsor);
  const data = Buffer.alloc(ACCOUNT_SIZE);
  data.set(await discriminator('account:EscrowAccount'));
  data.set(sponsor.toBytes(), 8);
  data.set(derived.bountyId, 40);
  data.writeBigUInt64LE(amount, 72);
  data.writeBigInt64LE(1_900_000_000n, 80);
  data[88] = status;
  data.set((status === 1 ? winner : SystemProgram.programId).toBytes(), 89);
  data[121] = derived.bump;
  return { derived, info: { owner: PROGRAM_ID, executable: false, lamports: Number(status === 0 ? amount : 0n) + rent, data } };
}

test('devnet guard uses the full 32-byte genesis hash and rejects mainnet and its truncated CAIP identifier', async () => {
  assert.equal(DEVNET_GENESIS, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  assert.equal(new PublicKey(DEVNET_GENESIS).toBytes().length, 32);
  await assertDevnet({ getGenesisHash: async () => DEVNET_GENESIS });
  await assert.rejects(assertDevnet({ getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }), /not Solana devnet/);
  await assert.rejects(assertDevnet({ getGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }), /not Solana devnet/);
});

test('listing hashing trims whitespace but does not normalize URL identity', async () => {
  assert.equal(validateListing(`  ${listing}  `), listing);
  assert.equal(validateListing('HTTPS://EXAMPLE.COM/path'), 'HTTPS://EXAMPLE.COM/path');
  const a = await deriveEscrow('https://example.com', sponsor);
  const b = await deriveEscrow('https://example.com/', sponsor);
  const c = await deriveEscrow('https://example.com', winner);
  assert.notEqual(a.address.toBase58(), b.address.toBase58());
  assert.notEqual(a.address.toBase58(), c.address.toBase58());
  assert.equal(a.address.toBase58(), (await deriveEscrow(' https://example.com ', sponsor)).address.toBase58());
});

for (const invalid of ['', 'javascript:alert(1)', 'file:///secret', 'https://name:secret@example.com/', 'https://example.com/#', 'https://example.com/#fragment', 'https://example.com/a b', 'https://exa\nmple.com', 'https:\\example.com', 'example.com', 'x'.repeat(2049)]) {
  test(`reject invalid or ambiguous listing ${JSON.stringify(invalid.slice(0, 45))}`, () => assert.throws(() => validateListing(invalid)));
}

test('SOL parsing is exact in lamports and display preserves all precision', () => {
  assert.equal(parseSol('0.000000001'), 1n);
  assert.equal(parseSol('123.000000009'), 123_000_000_009n);
  assert.equal(formatSol(123_000_000_009n), '123.000000009');
  assert.equal(formatSol(1_000_000_000n), '1');
  assert.equal(formatSol(0n), '0');
  assert.equal(formatSol(-1n), '-0.000000001');
});

for (const invalid of ['0', '-1', '1e2', '1,000', '.1', '1.0000000001', '01', '9007199.254740992', 'Infinity', '']) {
  test(`reject unsafe SOL amount ${JSON.stringify(invalid)}`, () => assert.throws(() => parseSol(invalid)));
}

test('deadlines require a valid future timestamp', () => {
  assert.equal(parseDeadline('2030-01-01T00:00:00Z', 1_800_000_000), 1_893_456_000);
  assert.throws(() => parseDeadline('not a date'));
  assert.throws(() => parseDeadline('2030-01-01T00:00:00Z', 1_893_456_000));
});

test('public addresses reject seed phrases and malformed values', () => {
  assert.equal(publicKey(sponsor.toBase58()).toBase58(), sponsor.toBase58());
  assert.throws(() => publicKey('this is never a valid wallet seed phrase'));
});

test('decode actual Anchor layout uses discriminator and exact field offsets', async () => {
  const { info } = await fixture();
  const decoded = await decodeEscrow(info.data);
  assert.equal(decoded.amount, amount);
  assert.equal(decoded.deadline, 1_900_000_000);
  assert.equal(decoded.sponsor.toBase58(), sponsor.toBase58());
  assert.equal(decoded.status, 'Funded');
});

test('a funded receipt must cover prize plus rent; settled receipts retain rent only', async () => {
  for (const status of [0, 1, 2]) {
    const { info, derived } = await fixture(status);
    const verified = await verifyAccount(info, derived, rent);
    assert.equal(verified.status, ['Funded', 'Awarded', 'Refunded'][status]);
  }
  const { info, derived } = await fixture();
  info.lamports--;
  await assert.rejects(verifyAccount(info, derived, rent), /balance/);
});

test('missing account is distinct from a funded receipt', async () => {
  const { derived } = await fixture();
  assert.equal(await verifyAccount(null, derived, rent), null);
});

for (const [name, mutate] of [
  ['wrong program owner', ({ info }) => { info.owner = sponsor; }],
  ['executable account', ({ info }) => { info.executable = true; }],
  ['bad discriminator', ({ info }) => { info.data[0] ^= 1; }],
  ['wrong sponsor', ({ info }) => { info.data[8] ^= 1; }],
  ['wrong listing hash', ({ info }) => { info.data[40] ^= 1; }],
  ['wrong bump', ({ info }) => { info.data[121] ^= 1; }],
  ['wrong account PDA', ({ derived }) => { derived.address = winner; }],
  ['truncated layout', ({ info }) => { info.data = info.data.subarray(0, 121); }],
  ['extra unexpected bytes', ({ info }) => { info.data = Buffer.concat([info.data, Buffer.from([0])]); }],
  ['unknown status', ({ info }) => { info.data[88] = 3; }],
  ['zero prize', ({ info }) => { info.data.writeBigUInt64LE(0n, 72); }],
  ['negative deadline', ({ info }) => { info.data.writeBigInt64LE(-1n, 80); }],
  ['unsafe RPC balance', ({ info }) => { info.lamports = Number.MAX_SAFE_INTEGER + 1; }],
  ['negative RPC balance', ({ info }) => { info.lamports = -1; }],
  ['winner on unsettled account', ({ info }) => { info.data.set(winner.toBytes(), 89); }],
]) {
  test(`verification rejects ${name}`, async () => {
    const value = await fixture(); mutate(value);
    await assert.rejects(verifyAccount(value.info, value.derived, rent));
  });
}

test('awarded receipt cannot record system, sponsor or escrow as winner', async () => {
  for (const recipient of [SystemProgram.programId, sponsor]) {
    const { info, derived } = await fixture(1); info.data.set(recipient.toBytes(), 89);
    await assert.rejects(verifyAccount(info, derived, rent), /recipient/);
  }
  const { info, derived } = await fixture(1); info.data.set(derived.address.toBytes(), 89);
  await assert.rejects(verifyAccount(info, derived, rent), /recipient/);
});

test('create instruction matches Anchor wire layout and account signer flags', async () => {
  const { derived } = await fixture();
  const instruction = await createInstruction(derived, amount, 1_900_000_000);
  assert.equal(instruction.data.length, 56);
  assert.deepEqual(instruction.data.subarray(0, 8), Buffer.from(await discriminator('global:create_bounty')));
  assert.deepEqual(instruction.data.subarray(8, 40), Buffer.from(derived.bountyId));
  assert.equal(instruction.data.readBigUInt64LE(40), amount);
  assert.equal(instruction.data.readBigInt64LE(48), 1_900_000_000n);
  assert.equal(instruction.keys[0].isSigner, true);
  assert.equal(instruction.keys[0].isWritable, true);
  assert.equal(instruction.keys[1].pubkey.toBase58(), derived.address.toBase58());
  assert.equal(instruction.keys[2].pubkey.toBase58(), SystemProgram.programId.toBase58());
});

test('award only targets an unsettled escrow and distinct recipient', async () => {
  const { info, derived } = await fixture(); const state = await verifyAccount(info, derived, rent);
  const instruction = await awardInstruction(state, winner);
  assert.equal(instruction.data.length, 8);
  assert.deepEqual(instruction.data, Buffer.from(await discriminator('global:award')));
  assert.equal(instruction.keys[0].pubkey.toBase58(), sponsor.toBase58());
  assert.equal(instruction.keys[0].isSigner, true);
  assert.equal(instruction.keys[2].pubkey.toBase58(), winner.toBase58());
  for (const recipient of [sponsor, derived.address, SystemProgram.programId]) await assert.rejects(awardInstruction(state, recipient));
  await assert.rejects(awardInstruction({ ...state, status: 'Awarded' }, winner));
});

test('refund always sends the prize to the original sponsor, never the caller', async () => {
  const { info, derived } = await fixture(); const state = await verifyAccount(info, derived, rent);
  const instruction = await refundInstruction(state, winner);
  assert.deepEqual(instruction.data, Buffer.from(await discriminator('global:refund')));
  assert.equal(instruction.keys[0].pubkey.toBase58(), winner.toBase58());
  assert.equal(instruction.keys[0].isSigner, true);
  assert.equal(instruction.keys[1].pubkey.toBase58(), sponsor.toBase58());
  assert.equal(instruction.keys[1].isWritable, true);
  await assert.rejects(refundInstruction({ ...state, status: 'Refunded' }, winner));
});

test('RPC inspection returns real context and refuses missing executable program', async () => {
  const { info, derived } = await fixture();
  const connection = {
    getGenesisHash: async () => DEVNET_GENESIS,
    getAccountInfo: async () => ({ executable: true, owner: SystemProgram.programId }),
    getAccountInfoAndContext: async address => { assert.equal(address.toBase58(), derived.address.toBase58()); return { value: info, context: { slot: 42 } }; },
    getMinimumBalanceForRentExemption: async () => rent,
  };
  const result = await inspectEscrow(connection, listing, sponsor);
  assert.equal(result.slot, 42);
  assert.equal(result.account.status, 'Funded');
  connection.getAccountInfo = async () => null;
  await assert.rejects(inspectEscrow(connection, listing, sponsor), /not deployed/);
});

test('failed simulation never yields a transaction ready to sign', async () => {
  const { derived } = await fixture();
  const instruction = await createInstruction(derived, amount, 1_900_000_000);
  const connection = {
    getGenesisHash: async () => DEVNET_GENESIS,
    getAccountInfo: async () => ({ executable: true, owner: SystemProgram.programId }),
    getLatestBlockhash: async () => ({ blockhash: sponsor.toBase58(), lastValidBlockHeight: 12 }),
    simulateTransaction: async () => ({ value: { err: { InstructionError: [0, { Custom: 6002 }] }, logs: ['Error Message: The deadline has not passed yet'] } }),
    getFeeForMessage: async () => ({ value: 5000 }),
  };
  await assert.rejects(prepareTransaction(connection, sponsor, instruction), /Simulation failed.*deadline/);
});

test('expired preview and changed wallet are stopped before signing', async () => {
  let called = false;
  const provider = { publicKey: winner, signTransaction: async () => { called = true; } };
  const expired = { preparedAt: Date.now() - 46_000, transaction: { feePayer: sponsor } };
  await assert.rejects(sendPrepared({}, provider, expired), /expired/);
  await assert.rejects(sendPrepared({}, provider, { ...expired, preparedAt: Date.now() }), /wallet changed/);
  assert.equal(called, false);
});

test('wallet cannot mutate an already-previewed transaction and have it sent', async () => {
  let sent = false;
  let message = Uint8Array.from([1, 2, 3]);
  const transaction = { feePayer: sponsor, serializeMessage: () => message };
  const connection = { getGenesisHash: async () => DEVNET_GENESIS, sendRawTransaction: async () => { sent = true; } };
  const provider = { publicKey: sponsor, signTransaction: async tx => { message = Uint8Array.from([9, 2, 3]); return tx; } };
  await assert.rejects(sendPrepared(connection, provider, { transaction, preparedAt: Date.now() }), /changed the transaction/);
  assert.equal(sent, false);
});

test('all explorer links explicitly target devnet', () => {
  assert.match(explorerAddress(sponsor), /\?cluster=devnet$/);
  assert.match(explorerTransaction('example'), /\?cluster=devnet$/);
});
