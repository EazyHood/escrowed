// Local-validator integration: executes the deployed SBF, not a state-machine mock.
// No key files, existing wallets, or external RPC endpoints are used.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const require = createRequire(resolve(process.env.ESCROWED_NODE_PACKAGE || 'package.json'));
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const endpoint = process.env.ESCROWED_LOCAL_RPC || 'http://127.0.0.1:8899';
const endpointUrl = new URL(endpoint);
assert(['localhost', '127.0.0.1', '[::1]'].includes(endpointUrl.hostname), 'This script only operates a local validator.');
const connection = new Connection(endpoint, 'confirmed');
const program = new PublicKey('EetC1jU5Zd686oKr7PuWG23Bfa6kjRuok2gCqxNZ5XPE');
const sponsor = Keypair.generate();
const stranger = Keypair.generate();
const winner = Keypair.generate();
const amount = 5_000_000n;
const cases = [];
const discriminator = name => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const bounty = () => randomBytes(32);
const address = id => PublicKey.findProgramAddressSync([Buffer.from('escrow'), sponsor.publicKey.toBuffer(), id], program)[0];
const account = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const ix = (name, keys, args = Buffer.alloc(0)) => new TransactionInstruction({ programId: program, keys, data: Buffer.concat([discriminator(name), args]) });
const create = (id, value, deadline) => {
  const args = Buffer.alloc(48); id.copy(args); args.writeBigUInt64LE(value, 32); args.writeBigInt64LE(BigInt(deadline), 40);
  return ix('create_bounty', [account(sponsor.publicKey, true, true), account(address(id), false, true), account(SystemProgram.programId)], args);
};
const award = (id, recipient = winner.publicKey, author = sponsor.publicKey) => ix('award', [account(author, true), account(address(id), false, true), account(recipient, false, true)]);
const refund = (id, caller = stranger.publicKey) => ix('refund', [account(caller, true), account(sponsor.publicKey, false, true), account(address(id), false, true)]);
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
async function chainTime() {
  const slot = await connection.getSlot('confirmed');
  const timestamp = await connection.getBlockTime(slot);
  assert(timestamp !== null, 'validator must provide a block timestamp');
  return timestamp;
}
async function send(name, instruction, payer, expectedCode = null) {
  const blockhash = await connection.getLatestBlockhash();
  const transaction = new Transaction({ feePayer: payer.publicKey, ...blockhash }).add(instruction);
  transaction.sign(payer);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
  const confirmation = await connection.confirmTransaction({ signature, ...blockhash }, 'confirmed');
  if (expectedCode === null) assert.equal(confirmation.value.err, null, name);
  else {
    assert(confirmation.value.err, `${name} must fail on the validator`);
    if (typeof expectedCode === 'number') assert.equal(confirmation.value.err.InstructionError?.[1]?.Custom, expectedCode, name);
  }
  cases.push({ name, signature, confirmed: true, expected: expectedCode === null ? 'success' : 'rejection', result: confirmation.value.err });
  console.log(`${name}: ${expectedCode === null ? 'success' : 'rejected'} ${signature}`);
  return signature;
}
async function read(id, expectedStatus) {
  const result = await connection.getAccountInfo(address(id), 'confirmed');
  assert(result, 'escrow account exists');
  assert(result.owner.equals(program));
  assert.equal(result.data.length, 122);
  assert.equal(result.data[88], expectedStatus);
  assert.equal(result.data.readBigUInt64LE(72), amount);
  return result;
}
async function waitPast(deadline) {
  for (let i = 0; i < 45; i++) {
    if (await chainTime() >= deadline) return;
    await sleep(1000);
  }
  throw new Error('Local validator clock did not advance to the deadline');
}

const startTime = new Date().toISOString();
const programAccount = await connection.getAccountInfo(program);
assert(programAccount?.executable, 'Load the current escrowed.so into the local validator before running this script');
const drop = await connection.requestAirdrop(sponsor.publicKey, 2 * LAMPORTS_PER_SOL);
await connection.confirmTransaction(drop, 'confirmed');
for (const recipient of [stranger.publicKey, winner.publicKey]) {
  await send(`fund test wallet ${recipient}`, SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: recipient, lamports: 50_000_000 }), sponsor);
}
const now = await chainTime();
const first = bounty();
await send('create funded bounty', create(first, amount, now + 120), sponsor);
const firstAccount = await read(first, 0);
const rent = await connection.getMinimumBalanceForRentExemption(122);
assert.equal(BigInt(firstAccount.lamports), BigInt(rent) + amount);
await send('reject wrong sponsor', award(first, winner.publicKey, stranger.publicKey), stranger, 'any');
await read(first, 0);
await send('reject sponsor as winner', award(first, sponsor.publicKey), sponsor, 6005);
await send('reject escrow as winner', award(first, address(first)), sponsor, 6006);
await send('reject early refund', refund(first), stranger, 6002);
const winnerBefore = await connection.getBalance(winner.publicKey);
await send('award valid winner', award(first), sponsor);
const awarded = await read(first, 1);
assert.equal(awarded.lamports, rent);
assert.equal(await connection.getBalance(winner.publicKey) - winnerBefore, Number(amount));
await send('reject second award', award(first), sponsor, 6001);
await send('reject refund after award', refund(first), stranger, 6001);
await send('reject zero amount', create(bounty(), 0n, now + 120), sponsor, 6003);
await send('reject expired creation', create(bounty(), amount, now - 1), sponsor, 6004);
const second = bounty();
const refundDeadline = await chainTime() + 4;
await send('create refundable bounty', create(second, amount, refundDeadline), sponsor);
await waitPast(refundDeadline);
const sponsorBefore = await connection.getBalance(sponsor.publicKey);
await send('stranger refunds expired bounty to sponsor', refund(second), stranger);
const refunded = await read(second, 2);
assert.equal(refunded.lamports, rent);
assert.equal(await connection.getBalance(sponsor.publicKey) - sponsorBefore, Number(amount));
await send('reject repeated refund', refund(second), stranger, 6001);
await send('reject award after refund', award(second), sponsor, 6001);
const third = bounty();
const lateDeadline = await chainTime() + 4;
await send('create late-award bounty', create(third, amount, lateDeadline), sponsor);
await waitPast(lateDeadline);
await send('award remains allowed after deadline until refunded', award(third), sponsor);
await read(third, 1);
const output = resolve(process.env.ESCROWED_CHAIN_REPORT || 'artifacts/evidence/local-validator.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ mode: 'local-validator-real-SBF', startTime, completedAt: new Date().toISOString(), endpoint, program: program.toBase58(), rent, cases, limitations: ['Local validator only; these signatures are not devnet or mainnet transactions.', 'Ephemeral wallets were generated in memory. No user wallet or private key file was used.'] }, null, 2)}\n`);
console.log(`Saved ${cases.length} confirmed transaction results to ${output}`);
