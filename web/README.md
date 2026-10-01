# Escrowed web client

Static Vite application, deployed under `/escrowed/`. No backend, private key,
wallet seed or server credential is included. The fixed RPC is Solana devnet;
the client checks the full devnet genesis hash before inspecting or signing.

```powershell
cd web
npm ci
npm test
npm run dev
npm run build
```

The browser implements three real workflows:

1. **Verify:** trim surrounding whitespace from an HTTP(S) listing URL, hash the
   exact remaining bytes, derive the canonical PDA with the supplied sponsor,
   then read the account and its balance from devnet. Verification checks the
   genesis hash, executable program, account owner, layout, discriminator,
   sponsor, listing hash, PDA, bump, settlement fields and rent/prize coverage.
2. **Fund:** connect an installed Phantom or Solflare wallet, enter the exact
   listing URL, test SOL prize and local refund date. Derive the PDA, validate
   input, reject an existing receipt, simulate, estimate the fee and account
   rent, then show a preview. Signing requires a separate explicit click.
3. **Settle:** refresh the verified receipt before any preview. A sponsor may
   award to a distinct non-executable recipient. Any connected caller may
   request a refund to the original sponsor; the program checks its clock.
  Simulation, preview, signature and confirmation are separate visible states.

Every preview includes the exact listing, escrow account, sponsor, signing
wallet, destination, amount, network, refund deadline and fee. A generation guard
invalidates pending asynchronous work when inputs, workflow, lookup or wallet
change. The guard runs again before signing and before sending the signed bytes.

Only the sponsor selects the winner. There is no judging, sponsor identity
verification or guarantee of payment for work. Once the refund date arrives,
award and refund race; the first valid settlement determines the outcome. The
upgradeable program has not undergone an independent security audit. Rent and
any unsolicited extra lamports stay in the receipt; no close instruction exists.

## Examples and privacy

`public/examples.json` may contain `{ "examples": [{ "label", "listing",
"sponsor" }] }`. Add only actual devnet test deposits with independently saved
transaction evidence. The UI calls these recorded test examples and fetches
their current state on demand. It never turns fixture data into a live receipt.

`public/deployment.json` starts with `status: "pending"`. Set `status` to
`"verified"` only after saving actual devnet deployment and end-to-end evidence,
and fill `evidence` with that public evidence path/URL. The banner says live only
when this record matches the program ID and the browser independently confirms
the devnet genesis hash and an executable program account.

The app stores no wallet keys, uses no analytics and does not auto-connect a
wallet. Reading or sending a transaction shares public addresses and request
metadata with the Solana RPC. Optional web fonts load from Google Fonts. A
shared verification URL contains the listing and sponsor as query parameters.

## Verification and dependency audit

`npm test` covers the 122-byte layout, exact URL identity, input validation,
unsafe RPC balances, ownership, PDA/discriminator/bump tampering, inconsistent
settlements, complete devnet genesis hash, wire instructions, simulation failure,
stale previews and wallet mutation. These unit tests do not claim an on-chain
execution; validator/devnet integration evidence is maintained at project root.

Vite is pinned to 7.3.6, which removes the known development-server high-severity
advisories found during setup. The dev server binds only to loopback. On
2026-10-01, `npm audit` still reports four moderate entries propagated through
`@solana/web3.js` → `jayson` → `uuid` / `stream-json`. The reported UUID issue is
for buffer-taking v3/v5/v6 functions; Jayson's browser client uses only v4 without
an output buffer. The `stream-json` filters are server-side modules not imported
by this browser bundle. Do not run `npm audit fix --force`: its suggested downgrade
of web3.js to 0.0.3 would break the client. Recheck upstream patches on updates;
this is a scoped assessment, not a claim that dependencies are audit-free.
