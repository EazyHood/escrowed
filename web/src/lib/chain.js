import { Buffer } from 'buffer';
import { Connection, PublicKey, SystemProgram, TransactionInstruction, Transaction, VersionedTransaction } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey('EetC1jU5Zd686oKr7PuWG23Bfa6kjRuok2gCqxNZ5XPE');
export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const ACCOUNT_SIZE = 122;
export const LAMPORTS = 1_000_000_000n;
export const ZERO_KEY = SystemProgram.programId;
const U64_MAX = (1n << 64n) - 1n;
const encoder = new TextEncoder();

export class FieldError extends Error {
  constructor(field, message) { super(message); this.name = 'FieldError'; this.field = field; }
}

// Trim only the surrounding whitespace. URL.href would silently normalize a
// trailing slash, case and escaping, changing the identifier already on chain.
export function validateListing(value) {
  const listing = String(value).trim();
  if (!listing || listing.length > 2048) throw new FieldError('listing', 'Use the full listing URL (up to 2,048 characters).');
  let parsed;
  try { parsed = new URL(listing); } catch { throw new FieldError('listing', 'Enter a valid https:// or http:// listing URL.'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || !/^https?:\/\//i.test(listing)) throw new FieldError('listing', 'The listing must start with https:// or http://.');
  if (parsed.username || parsed.password) throw new FieldError('listing', 'Remove the username or password from the listing URL.');
  if (listing.includes('#')) throw new FieldError('listing', 'Remove the #fragment. Use exactly the same listing URL when funding and verifying.');
  if (/[\u0000-\u0020\u007f\\]/.test(listing)) throw new FieldError('listing', 'Remove spaces, control characters and backslashes from the URL.');
  return listing;
}

export function publicKey(value, field = 'sponsor') {
  try { return new PublicKey(String(value).trim()); }
  catch { throw new FieldError(field, 'Enter a valid Solana public address. Never enter a seed phrase or private key.'); }
}

export async function sha256(value) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value));
}

export async function discriminator(name) { return (await sha256(name)).slice(0, 8); }
export async function deriveEscrow(listingValue, sponsorValue) {
  const listing = validateListing(listingValue);
  const sponsor = sponsorValue instanceof PublicKey ? sponsorValue : publicKey(sponsorValue);
  const bountyId = await sha256(listing);
  const [address, bump] = PublicKey.findProgramAddressSync([Buffer.from('escrow'), sponsor.toBuffer(), Buffer.from(bountyId)], PROGRAM_ID);
  return { listing, sponsor, bountyId, address, bump };
}

export function parseSol(value) {
  const input = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(input)) throw new FieldError('amount', 'Use a positive SOL amount with up to 9 decimal places (no commas or exponent).');
  const [whole, fraction = ''] = input.split('.');
  const amount = BigInt(whole) * LAMPORTS + BigInt(fraction.padEnd(9, '0'));
  if (amount === 0n || amount > U64_MAX || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new FieldError('amount', 'Choose an amount greater than zero and below 9,007,199 SOL.');
  return amount;
}

export function formatSol(lamports) {
  const amount = BigInt(lamports);
  const sign = amount < 0n ? '-' : '';
  const abs = amount < 0n ? -amount : amount;
  const fraction = (abs % LAMPORTS).toString().padStart(9, '0').replace(/0+$/, '');
  return `${sign}${abs / LAMPORTS}${fraction ? `.${fraction}` : ''}`;
}

export function parseDeadline(value, nowSeconds = Math.floor(Date.now() / 1000)) {
  const milliseconds = new Date(value).getTime();
  const seconds = Math.floor(milliseconds / 1000);
  if (!Number.isSafeInteger(seconds) || seconds <= nowSeconds) throw new FieldError('deadline', 'Choose a refund deadline in the future. The time uses your device’s time zone.');
  return seconds;
}

export async function decodeEscrow(dataValue) {
  const data = new Uint8Array(dataValue);
  if (data.length !== ACCOUNT_SIZE) throw new Error(`The account has an unexpected layout (${data.length} bytes). No backing is verified.`);
  const expected = await discriminator('account:EscrowAccount');
  if (!bytesEqual(data.slice(0, 8), expected)) throw new Error('The account discriminator does not match Escrowed. No backing is verified.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const statusCode = data[88];
  if (statusCode > 2) throw new Error('The account has an unknown settlement status.');
  const amount = view.getBigUint64(72, true);
  const deadlineBig = view.getBigInt64(80, true);
  if (amount === 0n || deadlineBig <= 0n || deadlineBig > BigInt(8_640_000_000_000)) throw new Error('The account contains an invalid amount or deadline.');
  return {
    sponsor: new PublicKey(data.slice(8, 40)), bountyId: data.slice(40, 72),
    amount, deadline: Number(deadlineBig), status: ['Funded', 'Awarded', 'Refunded'][statusCode],
    winner: new PublicKey(data.slice(89, 121)), bump: data[121],
  };
}

export function bytesEqual(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }

export async function verifyAccount(accountInfo, derived, rentReserve) {
  if (!accountInfo) return null;
  if (!accountInfo.owner.equals(PROGRAM_ID)) throw new Error('The derived account is owned by another program. No backing is verified.');
  if (accountInfo.executable) throw new Error('The derived address is executable, not an escrow receipt.');
  if (!Number.isSafeInteger(accountInfo.lamports) || accountInfo.lamports < 0 || !Number.isSafeInteger(rentReserve) || rentReserve < 0) throw new Error('The RPC returned an unsafe balance. No backing is verified.');
  const state = await decodeEscrow(accountInfo.data);
  if (!state.sponsor.equals(derived.sponsor) || !bytesEqual(state.bountyId, derived.bountyId) || state.bump !== derived.bump) throw new Error('The receipt does not match this exact listing, sponsor and PDA bump.');
  const [canonicalAddress, canonicalBump] = PublicKey.findProgramAddressSync([Buffer.from('escrow'), state.sponsor.toBuffer(), Buffer.from(state.bountyId)], PROGRAM_ID);
  if (!canonicalAddress.equals(derived.address) || canonicalBump !== state.bump) throw new Error('The account is not the canonical escrow PDA.');
  const balance = BigInt(accountInfo.lamports);
  const rent = BigInt(rentReserve);
  if (balance < rent || (state.status === 'Funded' && balance < state.amount + rent)) throw new Error('The escrow balance does not cover the expected prize plus rent reserve. No funded backing is verified.');
  if (state.status === 'Awarded') {
    if (state.winner.equals(ZERO_KEY) || state.winner.equals(state.sponsor) || state.winner.equals(derived.address)) throw new Error('The settled account has an invalid recipient.');
  } else if (!state.winner.equals(ZERO_KEY)) throw new Error('The receipt contains inconsistent settlement fields.');
  return { ...state, address: derived.address, listing: derived.listing, balance, rentReserve: rent };
}

export function createConnection() {
  return new Connection(DEVNET_RPC, {
    commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }),
  });
}

export async function assertDevnet(connection) {
  if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('This RPC is not Solana devnet. The request was stopped.');
}

export async function getProgramState(connection) {
  const account = await connection.getAccountInfo(PROGRAM_ID, 'confirmed');
  return account && account.executable ? { deployed: true, owner: account.owner.toBase58() } : { deployed: false };
}

export async function inspectEscrow(connection, listing, sponsor) {
  const derived = await deriveEscrow(listing, sponsor);
  await assertDevnet(connection);
  const [program, receipt, rent] = await Promise.all([
    getProgramState(connection), connection.getAccountInfoAndContext(derived.address, { commitment: 'confirmed' }),
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed'),
  ]);
  if (!program.deployed) throw new Error('Escrowed is not deployed as an executable program on this devnet RPC. No backing is verified.');
  const account = await verifyAccount(receipt.value, derived, rent);
  return { account, derived, slot: receipt.context.slot, checkedAt: new Date().toISOString(), program };
}

function instructionData(prefix, size) {
  const data = Buffer.alloc(size);
  data.set(prefix);
  return data;
}

export async function createInstruction(derived, amount, deadline) {
  amount = BigInt(amount);
  if (amount <= 0n || amount > U64_MAX || !Number.isSafeInteger(deadline) || deadline <= 0) throw new Error('Invalid creation amount or deadline.');
  const data = instructionData(await discriminator('global:create_bounty'), 56);
  data.set(derived.bountyId, 8);
  data.writeBigUInt64LE(amount, 40);
  data.writeBigInt64LE(BigInt(deadline), 48);
  return new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
    { pubkey: derived.sponsor, isSigner: true, isWritable: true },
    { pubkey: derived.address, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ] });
}

export async function awardInstruction(state, winnerValue) {
  const winner = winnerValue instanceof PublicKey ? winnerValue : publicKey(winnerValue, 'winner');
  if (state.status !== 'Funded') throw new Error('This escrow has already been settled.');
  if (winner.equals(state.sponsor) || winner.equals(state.address) || winner.equals(ZERO_KEY)) throw new FieldError('winner', 'Choose a recipient other than the sponsor, escrow or system program.');
  return new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.from(await discriminator('global:award')), keys: [
    { pubkey: state.sponsor, isSigner: true, isWritable: false },
    { pubkey: state.address, isSigner: false, isWritable: true },
    { pubkey: winner, isSigner: false, isWritable: true },
  ] });
}

export async function refundInstruction(state, callerValue) {
  const caller = callerValue instanceof PublicKey ? callerValue : publicKey(callerValue, 'caller');
  if (state.status !== 'Funded') throw new Error('This escrow has already been settled.');
  return new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.from(await discriminator('global:refund')), keys: [
    { pubkey: caller, isSigner: true, isWritable: false },
    { pubkey: state.sponsor, isSigner: false, isWritable: true },
    { pubkey: state.address, isSigner: false, isWritable: true },
  ] });
}

export async function prepareTransaction(connection, payer, instruction) {
  await assertDevnet(connection);
  const program = await getProgramState(connection);
  if (!program.deployed) throw new Error('The devnet program is not deployed. No signature was requested.');
  const blockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: payer, ...blockhash }).add(instruction);
  // Simulate the same message that the wallet will see, without a signature.
  const versioned = new VersionedTransaction(transaction.compileMessage());
  const [simulation, fee] = await Promise.all([
    connection.simulateTransaction(versioned, { sigVerify: false, commitment: 'confirmed' }),
    connection.getFeeForMessage(transaction.compileMessage(), 'confirmed'),
  ]);
  if (simulation.value.err) {
    const detail = simulation.value.logs?.findLast(log => log.includes('Error Message:')) || JSON.stringify(simulation.value.err);
    throw new Error(`Simulation failed. Nothing was signed or sent. ${detail}`);
  }
  if (fee.value === null) throw new Error('The fee estimate expired. Review the transaction again.');
  return { transaction, blockhash, fee: BigInt(fee.value), units: simulation.value.unitsConsumed, preparedAt: Date.now() };
}

export async function sendPrepared(connection, provider, prepared, onProgress = () => {}) {
  prepared.assertCurrent?.();
  if (Date.now() - prepared.preparedAt > 45_000) throw new Error('The preview expired. Close it and review the transaction again.');
  if (!provider.publicKey || !provider.publicKey.equals(prepared.transaction.feePayer)) throw new Error('The connected wallet changed. Review the transaction again.');
  await assertDevnet(connection);
  prepared.assertCurrent?.();
  if (!provider.publicKey || !provider.publicKey.equals(prepared.transaction.feePayer)) throw new Error('The connected wallet changed. Review the transaction again.');
  onProgress('signature');
  const expectedMessage = new Uint8Array(prepared.transaction.serializeMessage());
  const signed = await provider.signTransaction(prepared.transaction);
  prepared.assertCurrent?.();
  if (!bytesEqual(signed.serializeMessage(), expectedMessage)) throw new Error('The wallet changed the transaction message. It was not sent.');
  onProgress('sending');
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
  onProgress('confirming', signature);
  const result = await connection.confirmTransaction({ signature, ...prepared.blockhash }, 'confirmed');
  if (result.value.err) throw new Error(`The transaction did not succeed: ${JSON.stringify(result.value.err)}. Check its explorer receipt.`);
  onProgress('confirmed', signature);
  return signature;
}

export function explorerAddress(address) { return `https://explorer.solana.com/address/${encodeURIComponent(String(address))}?cluster=devnet`; }
export function explorerTransaction(signature) { return `https://explorer.solana.com/tx/${encodeURIComponent(String(signature))}?cluster=devnet`; }
export function readableError(error) {
  const message = String(error?.message || error);
  if (/rejected|denied|cancel/i.test(message)) return 'You cancelled the wallet request. Nothing was submitted by this action.';
  if (/429|403|fetch|timeout|aborted/i.test(message)) return 'The public devnet RPC is busy or unreachable. Nothing is verified. Wait a moment, then try again.';
  return message;
}
