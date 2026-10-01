// Preserve the actual local-validator transaction metadata after chain-smoke.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(resolve(process.env.ESCROWED_NODE_PACKAGE || 'package.json'));
const { Connection } = require('@solana/web3.js');
const file = resolve(process.env.ESCROWED_CHAIN_REPORT || 'artifacts/evidence/local-validator.json');
const report = JSON.parse(await readFile(file, 'utf8'));
assert.equal(report.mode, 'local-validator-real-SBF');
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(report.endpoint).hostname));
const connection = new Connection(report.endpoint, 'confirmed');
const transactions = [];
for (const result of report.cases) {
  const transaction = await connection.getTransaction(result.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  assert(transaction, `Missing transaction ${result.signature}`);
  transactions.push({ name: result.name, signature: result.signature, expected: result.expected, slot: transaction.slot, blockTime: transaction.blockTime, meta: transaction.meta });
}
await writeFile(resolve('artifacts/evidence/local-transactions.json'), `${JSON.stringify({ network: 'local-validator', exportedAt: new Date().toISOString(), program: report.program, transactions }, null, 2)}\n`);
console.log(`Exported ${transactions.length} actual transaction metadata records; no wallets or private keys.`);
