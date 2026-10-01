// Default: print an offline plan. Only --execute-devnet can read private keys
// or send transactions. The RPC is fixed to devnet and its genesis is checked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile, stat } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROGRAM_ID, DEVNET_RPC, DEVNET_GENESIS, ACCOUNT_SIZE,
  createConnection, assertDevnet, getProgramState, deriveEscrow,
  inspectEscrow, createInstruction, awardInstruction, refundInstruction,
  prepareTransaction, sendPrepared, explorerAddress, explorerTransaction,
} from '../web/src/lib/chain.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(repo, 'web/package.json'));
const { Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');
const base58Module = require('bs58');
const base58 = base58Module.default || base58Module;
const flags = new Set(process.argv.slice(2));
for (const flag of flags) assert(['--plan', '--execute-devnet', '--initialize-test-wallets', '--help'].includes(flag), 'Unknown option');
const execute = flags.has('--execute-devnet');
const initializeWallets = flags.has('--initialize-test-wallets');
const privateRoot = resolve(repo, '../escrowed-devnet-keys');
const expectedSponsor = new PublicKey('3rfnzNgH7v2y9uoz2ExEmw3QLzpzD6TBpejLKo7pUeqv');
const prize = 1_000_000n; // 0.001 test SOL; enough for a fresh system account.
const totalOutflowLimit = 20_000_000n; // 0.02 test SOL, excludes program deployment.
const feeLimit = 50_000n;
const recipientFile = 'example-recipient.json';
const callerFile = 'example-refund-caller.json';
const reportPath = resolve(repo, 'artifacts/evidence/devnet-examples.json');
const definitions = [
  { name: 'funded', expected: 'Funded', listing: 'https://github.com/EazyHood/escrowed/blob/main/examples/funded.md' },
  { name: 'awarded', expected: 'Awarded', listing: 'https://github.com/EazyHood/escrowed/blob/main/examples/awarded.md' },
  { name: 'refunded', expected: 'Refunded', listing: 'https://github.com/EazyHood/escrowed/blob/main/examples/refunded.md' },
];
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));

if (flags.has('--help')) {
  console.log('node scripts/devnet-examples.mjs [--plan]\nnode scripts/devnet-examples.mjs --execute-devnet [--initialize-test-wallets]');
  console.log('The default plan reads no keys and makes no RPC calls. Execution is fixed to Solana devnet, capped at 0.02 test SOL, and journals signatures before submission.');
  process.exit(0);
}

const derived = await Promise.all(definitions.map(async definition => ({ ...definition, ...(await deriveEscrow(definition.listing, expectedSponsor)) })));
if (!execute) {
  console.log(json({
    mode: 'offline-plan-no-keys-no-RPC-no-transactions',
    rpc: DEVNET_RPC, requiredGenesis: DEVNET_GENESIS, program: PROGRAM_ID.toBase58(),
    sponsor: expectedSponsor.toBase58(), prizeLamportsPerExample: prize,
    maximumGrossOutflowLamports: totalOutflowLimit,
    deploymentIncluded: false,
    privateKeyFiles: ['deployer.json', recipientFile, callerFile],
    privateKeyLocation: 'Sibling escrowed-devnet-keys directory; never the repository',
    initializeTestWalletsRequiresFlag: true,
    examples: derived.map(item => ({ name: item.name, listing: item.listing, address: item.address.toBase58(), expectedFinalState: item.expected })),
    next: 'Deploy and verify the current program first. Run only with explicit --execute-devnet; keep the actual report separate from this plan.',
  }));
  process.exit(0);
}

assert(!flags.has('--plan'), 'Choose --plan or --execute-devnet, not both');
const connection = createConnection();
await assertDevnet(connection);
assert.equal(await connection.getGenesisHash(), DEVNET_GENESIS);
const program = await getProgramState(connection);
assert(program.deployed, 'The program must already be deployed on devnet');
assert.equal(program.owner, 'BPFLoaderUpgradeab1e11111111111111111111111', 'Unexpected deployed program loader');
for (const item of definitions) {
  const page = await fetch(item.listing, { signal: AbortSignal.timeout(20_000) });
  assert(page.ok, `Publish the exact example document before funding it: ${item.listing}`);
}
assert(samePath(await realpath(privateRoot), privateRoot), 'The private folder must not redirect elsewhere');

async function loadWallet(filename, mayCreate) {
  const file = resolve(privateRoot, filename);
  assert(samePath(dirname(file), privateRoot));
  try {
    const info = await stat(file);
    assert(info.isFile() && info.size < 4096, 'Invalid private wallet file');
    assert(samePath(await realpath(file), file), 'Wallet path must remain in the authorized private folder');
  } catch (error) {
    if (error.code !== 'ENOENT' || !mayCreate || !initializeWallets) throw new Error(`Missing or invalid ${filename}; initialization of new test wallets requires --initialize-test-wallets`);
    const wallet = Keypair.generate();
    await writeFile(file, JSON.stringify(Array.from(wallet.secretKey)), { flag: 'wx', mode: 0o600 });
  }
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert(Array.isArray(raw) && raw.length === 64 && raw.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255), 'Invalid wallet encoding');
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const sponsor = await loadWallet('deployer.json', false);
assert(sponsor.publicKey.equals(expectedSponsor), 'Deployer is not the approved devnet test wallet');
const recipient = await loadWallet(recipientFile, true);
const caller = await loadWallet(callerFile, true);
assert(!recipient.publicKey.equals(sponsor.publicKey) && !caller.publicKey.equals(sponsor.publicKey) && !recipient.publicKey.equals(caller.publicKey), 'Examples require distinct test wallets');
assert(!recipient.publicKey.equals(PROGRAM_ID) && !caller.publicKey.equals(PROGRAM_ID), 'The program address is not a test wallet');

await mkdir(dirname(reportPath), { recursive: true });
let report;
try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (report) {
  assert.equal(report.network, 'devnet');
  assert.equal(report.genesis, DEVNET_GENESIS);
  assert.equal(report.sponsor, sponsor.publicKey.toBase58());
  assert.equal(report.recipient, recipient.publicKey.toBase58());
  assert.equal(report.refundCaller, caller.publicKey.toBase58());
} else {
  report = { network: 'devnet', genesis: DEVNET_GENESIS, rpc: DEVNET_RPC,
    program: PROGRAM_ID.toBase58(), sponsor: sponsor.publicKey.toBase58(),
    recipient: recipient.publicKey.toBase58(), refundCaller: caller.publicKey.toBase58(),
    startedAt: new Date().toISOString(), status: 'in_progress', transactions: [], examples: [],
    limitations: ['Devnet test tokens, not monetary rewards or real bounty payments.', 'The sponsor controls winner selection; refunds return to the sponsor.', 'A funded example can change later; consult the current network state.', 'No private key or receipt is included in this report.'] };
}
function persist() {
  const temporary = `${reportPath}.tmp`;
  writeFileSync(temporary, `${json(report)}\n`);
  renameSync(temporary, reportPath);
}

// Never blindly resend a previously signed transaction after an uncertain result.
for (const transaction of report.transactions.filter(item => item.status !== 'confirmed')) {
  assert(transaction.signature, 'An incomplete transaction journal requires review before retrying');
  const result = await connection.getSignatureStatuses([transaction.signature], { searchTransactionHistory: true });
  const observed = result.value[0];
  if (!observed || observed.err || !['confirmed', 'finalized'].includes(observed.confirmationStatus)) {
    throw new Error(`Reconcile the recorded transaction before retrying: ${transaction.signature}`);
  }
  transaction.status = 'confirmed'; transaction.slot = observed.slot; transaction.reconciledAt = new Date().toISOString();
  persist();
}
let budgetUsed = report.transactions.reduce((sum, item) => sum + BigInt(item.grossOutflowLamports || 0), 0n);
assert(budgetUsed <= totalOutflowLimit, 'The run budget was already consumed');
async function send(label, instruction, payer, transferAmount = 0n) {
  await assertDevnet(connection);
  const prepared = await prepareTransaction(connection, payer.publicKey, instruction);
  assert(prepared.fee <= feeLimit, 'Unexpected transaction fee');
  const cost = transferAmount + prepared.fee;
  assert(budgetUsed + cost <= totalOutflowLimit, 'The 0.02 test SOL gross outflow cap would be exceeded');
  const record = { label, status: 'prepared', payer: payer.publicKey.toBase58(), feeEstimateLamports: prepared.fee.toString(), grossOutflowLamports: cost.toString(), lastValidBlockHeight: prepared.blockhash.lastValidBlockHeight, preparedAt: new Date().toISOString() };
  report.transactions.push(record); budgetUsed += cost; persist();
  const provider = { publicKey: payer.publicKey, async signTransaction(transaction) {
    transaction.sign(payer);
    record.signature = base58.encode(transaction.signature); record.explorer = explorerTransaction(record.signature);
    record.status = 'signed_not_sent'; persist(); return transaction;
  } };
  try {
    await sendPrepared(connection, provider, prepared, (stage, signature) => {
      if (stage === 'sending') record.status = 'send_started';
      if (signature) record.signature = signature;
      if (stage === 'confirmed') record.status = 'confirmed';
      persist();
    });
    record.confirmedAt = new Date().toISOString();
    const details = await connection.getTransaction(record.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (details) { record.slot = details.slot; record.actualFeeLamports = details.meta?.fee; record.result = details.meta?.err; }
    persist(); console.log(`${label}: confirmed ${record.signature}`);
  } catch (error) {
    record.error = String(error.message || error); report.status = 'requires_reconciliation'; persist(); throw error;
  }
}
async function observe(item) {
  return inspectEscrow(connection, item.listing, sponsor.publicKey);
}
async function proveBalance(label, recipientKey) {
  const record = report.transactions.findLast(item => item.label === label && item.status === 'confirmed');
  assert(record?.signature, `A recorded confirmed transaction is required for ${label}`);
  let details;
  for (let attempt = 0; attempt < 4; attempt++) {
    details = await connection.getTransaction(record.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (details) break;
    await sleep(750);
  }
  assert(details?.meta && details.meta.err === null, 'Confirmed transaction metadata is required to prove the balance change');
  const keys = details.transaction.message.accountKeys;
  assert(Array.isArray(keys), 'Expected the legacy transaction generated by this runner');
  const index = keys.findIndex(key => key.equals(recipientKey));
  assert(index >= 0, 'The recorded transaction does not include the expected recipient');
  const before = details.meta.preBalances[index];
  const after = details.meta.postBalances[index];
  assert.equal(after - before, Number(prize), 'The actual transaction did not credit the exact prize');
  return { address: recipientKey.toBase58(), signature: record.signature, slot: details.slot, beforeLamports: before, afterLamports: after, deltaLamports: after - before, source: 'confirmed transaction meta preBalances/postBalances' };
}
async function chainTime() {
  const timestamp = await connection.getBlockTime(await connection.getSlot('confirmed'));
  assert(timestamp !== null, 'Devnet did not return a chain timestamp'); return timestamp;
}
async function ensureCreated(item) {
  const result = await observe(item);
  if (result.account) { assert.equal(result.account.amount, prize, 'Existing example amount differs'); return result; }
  const deadline = await chainTime() + (item.name === 'refunded' ? 30 : 30 * 24 * 60 * 60);
  const rent = BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed'));
  await send(`create ${item.name}`, await createInstruction(item, prize, deadline), sponsor, prize + rent);
  const created = await observe(item); assert.equal(created.account?.status, 'Funded');
  return created;
}
function snapshot(item, result) {
  const state = result.account;
  return { name: item.name, listing: item.listing, address: item.address.toBase58(), explorer: explorerAddress(item.address),
    state: state.status, amountLamports: state.amount.toString(), accountLamports: state.balance.toString(), rentReserveLamports: state.rentReserve.toString(),
    sponsor: state.sponsor.toBase58(), winner: state.winner.toBase58(), deadline: state.deadline,
    slot: result.slot, checkedAt: result.checkedAt };
}

try {
  const rent = BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed'));
  const maximumNeeded = 3n * (prize + rent) + 1_000_000n + 6n * feeLimit;
  assert(maximumNeeded <= totalOutflowLimit, 'Current rent/fees exceed the configured cap');
  const existing = await Promise.all(derived.map(observe));
  const missing = existing.filter(item => !item.account).length;
  const refundStillNeeded = !existing[2].account || existing[2].account.status === 'Funded';
  const callerBalance = refundStillNeeded ? await connection.getBalance(caller.publicKey, 'confirmed') : 1_000_000;
  const callerTopUp = BigInt(Math.max(0, 1_000_000 - callerBalance));
  const awardStillNeeded = !existing[1].account || existing[1].account.status === 'Funded';
  const pendingTransactions = missing + (awardStillNeeded ? 1 : 0) + (refundStillNeeded ? 1 : 0) + (callerTopUp > 0n ? 1 : 0);
  const reserveForRemaining = BigInt(missing) * (prize + rent) + callerTopUp + BigInt(pendingTransactions) * feeLimit;
  const beforeSponsor = await connection.getBalance(sponsor.publicKey, 'confirmed');
  assert(BigInt(beforeSponsor) >= reserveForRemaining, `The dedicated devnet wallet needs ${reserveForRemaining} lamports for the remaining examples after deployment`);
  report.initialSponsorLamports ??= beforeSponsor; persist();
  const funded = await ensureCreated(derived[0]);
  assert.equal(funded.account.status, 'Funded', 'The public funded fixture has already been settled; do not silently replace its identity');
  assert(funded.account.deadline > await chainTime(), 'The funded fixture has expired; review its identity before another run');
  report.examples = [snapshot(derived[0], funded)]; persist();

  let awarded = await ensureCreated(derived[1]);
  if (awarded.account.status === 'Funded') {
    await send('award example prize', await awardInstruction(awarded.account, recipient.publicKey), sponsor);
    awarded = await observe(derived[1]);
  }
  assert.equal(awarded.account.status, 'Awarded'); assert(awarded.account.winner.equals(recipient.publicKey));
  report.awardBalanceProof = await proveBalance('award example prize', recipient.publicKey);
  report.examples.push(snapshot(derived[1], awarded)); persist();

  let refunded = await ensureCreated(derived[2]);
  if (refunded.account.status === 'Funded') {
    const callerBalance = await connection.getBalance(caller.publicKey, 'confirmed');
    const callerTarget = 1_000_000;
    if (callerBalance < callerTarget) {
      const addition = callerTarget - callerBalance;
      await send('fund dedicated refund caller', SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: caller.publicKey, lamports: addition }), sponsor, BigInt(addition));
    }
    console.log(`Waiting for the refund deadline ${refunded.account.deadline} on devnet`);
    for (let attempt = 0; await chainTime() < refunded.account.deadline; attempt++) {
      assert(attempt < 45, 'Deadline did not arrive within the bounded wait'); await sleep(2000);
    }
    await send('third-party refund to sponsor', await refundInstruction(refunded.account, caller.publicKey), caller);
    refunded = await observe(derived[2]);
  }
  assert.equal(refunded.account.status, 'Refunded');
  report.refundBalanceProof = { ...(await proveBalance('third-party refund to sponsor', sponsor.publicKey)), caller: caller.publicKey.toBase58() };
  report.examples.push(snapshot(derived[2], refunded));
  report.finalSponsorLamports = await connection.getBalance(sponsor.publicKey, 'confirmed');
  report.grossOutflowBudgetUsedLamports = budgetUsed.toString(); report.maximumGrossOutflowLamports = totalOutflowLimit.toString();
  report.status = 'confirmed'; report.completedAt = new Date().toISOString(); persist();
  console.log(`All three states observed on devnet; public evidence saved to ${reportPath}`);
} catch (error) {
  report.status = 'incomplete'; report.lastError = String(error.message || error); persist(); throw error;
}
