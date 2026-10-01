# Reproducing the public devnet examples

The default command is an offline plan. It reads no keys, requests no RPC data,
and sends no transactions:

```powershell
node scripts/devnet-examples.mjs --plan
```

Before execution, the exact three example documents must be published on the
repository's `main` branch and the current program must already be deployed and
verified on devnet. Program deployment is separate from this script's budget.
Keep the dedicated deployer key outside the repo, in the sibling directory
`escrowed-devnet-keys/deployer.json`. It must be the documented test wallet
`3rfnzNgH7v2y9uoz2ExEmw3QLzpzD6TBpejLKo7pUeqv`.

Once publication and test-token funding are ready, the explicitly authorized
execution command is:

```powershell
node scripts/devnet-examples.mjs --execute-devnet --initialize-test-wallets
```

The initialization flag only permits creating the two missing dedicated test
wallet files `example-recipient.json` and `example-refund-caller.json` inside
that same private directory. It never replaces an existing file or uses the
program keypair as a wallet. Subsequent runs can omit the initialization flag.
Do not place these private files, their contents, or subscription receipts in
the repo or public artifacts.

Execution checks the fixed public devnet RPC, exact devnet genesis hash and
executable program before reading keys. No RPC override or mainnet mode exists.
The three prizes are 0.001 test SOL each; account rents and fees are additional.
The script caps the **gross planned outflow at 0.02 test SOL**, excluding program
deployment, and refuses unexpected rent/fees. A fresh run normally needs less
than 0.01 test SOL after deployment, but it queries current amounts rather than
assuming that estimate.

The runner uses the same instruction builders, simulation, genesis checks and
submission flow as the web client. It signs with the dedicated test wallets,
journals each signature before sending, and records confirmed states and
balances in `artifacts/evidence/devnet-examples.json`. Private keys are never
included. If a send becomes uncertain, the next run checks the recorded
signature and stops if it cannot establish confirmation; it does not blindly
send it again. Review unresolved signatures before retrying.

The fixed listing URL and sponsor derive a permanent PDA. Completed examples
are inspected and reused instead of creating duplicate accounts. If somebody
settles the intended funded example, the script stops rather than pretending
it is still open. Changing the listing identity requires an explicit new
example document and a new recorded run, not an invisible reset.

Only a report with `status: "confirmed"`, current chain observations and actual
signatures establishes that all three examples were completed. Local-validator
proof, source code, dry plans and these documents do not establish devnet use.
