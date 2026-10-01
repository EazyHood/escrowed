# Escrowed

**Check the prize before you do the work.**

Escrowed adds a verifiable funding link to an existing bounty. A sponsor locks
native SOL against the exact listing URL. A contributor can inspect its owner,
address, balance, deadline and settlement state without connecting a wallet.
The listing stays on GitHub, Superteam or another site; there is no marketplace
to migrate to.

**This version is a devnet prototype. Devnet SOL is a free test asset with no
monetary value. It is not an audited service for real funds.** Deployment status
and test evidence belong in [`artifacts/`](artifacts/); a successful compilation
by itself does not mean the program has been deployed.

## The useful distinction

A listing can promise a prize. An escrow can show whether that prize is currently
locked. Those are different statements. Escrowed checks the latter and makes its
limits visible:

- The sponsor chooses the recipient. A funded account does not guarantee fair
  judging, selection or payment to a particular contributor.
- Anyone may refund an unawarded prize at or after the deadline. **The refund
  goes back to the sponsor**, never to the caller or a worker.
- Late awards are allowed. After the deadline, an award and a refund can race;
  the first successful transaction decides the outcome.
- The program is upgradeable. Its authority could change the code. This
  prototype does not offer immutability, insurance or dispute resolution.
- A URL hash binds exact text, not the website author's identity. Check the
  sponsor address against a trusted source from that sponsor.

## A complete route

1. The sponsor enters a public HTTP(S) listing URL, prize and refund deadline,
   reviews the transaction, and signs a devnet funding transaction.
2. The app confirms it and produces a shareable verification link.
3. A contributor opens the link and reads the live escrow without a wallet.
4. The sponsor can award to another wallet, or anyone can return an unawarded
   prize to the sponsor after its deadline. Each escrow settles at most once.

One PDA exists per sponsor and exact URL. A settled URL cannot be used again by
that sponsor; publish a distinct listing for a new bounty. Account rent stays
in the PDA to retain its history. Unsolicited extra SOL also stays there: this
version has no sweep or close instruction. Do not send additional funds directly
to an escrow account.

## Run the web client

Node.js 22 or newer:

```sh
cd web
npm ci
npm test
npm run dev -- --host 127.0.0.1
```

The client is restricted to Solana devnet and verifies its genesis hash before
transaction operations. The public site is built for the `/escrowed/` path on
GitHub Pages. No server, API key or private key is shipped in its bundle.

The public RPC can be slow or rate-limited. A failed lookup is **unverified**,
not evidence that a bounty is funded or unfunded. The UI provides error recovery
and labels the network and observed state.

## Run the read-only CLI

```sh
cargo run --bin verify -- <ESCROW_ADDRESS> <SPONSOR_ADDRESS> <EXACT_LISTING_URL>
```

Optional `--rpc URL` changes the read-only endpoint. The default is devnet.
The URL is trimmed and hashed as exact UTF-8 text; credentials and fragments are
rejected. Case, query strings and trailing slashes are not silently normalized.
Use the exact URL in the sponsor's verification link.

The verifier checks program ownership, non-executable account status, fixed
layout, Anchor discriminator, sponsor, URL hash, PDA, bump and whether the live
balance covers both prize and rent. It reads at `finalized` commitment and reports
the slot. It never signs transactions or asks for a private key.

Exit codes: `0` prize currently locked; `1` awarded/refunded; `2` account not
found; `3` invalid input, inconsistent evidence or RPC error. Code `0` is a funding
snapshot, not a recommendation to work or a payment guarantee.

## Build and verify

```sh
cargo test --locked
cargo test --locked --no-default-features
cargo test --locked --manifest-path programs/escrowed/Cargo.toml
```

The core state-machine tests cover invalid transitions and every ordering of
award/refund. Host program tests cover layout, serialization, destination alias,
rent, insufficient balance and arithmetic overflow. Client tests exercise the
read path and instruction encoding. These checks are complemented by actual SBF
transactions on a local validator; see [DEPLOY.md](DEPLOY.md) for reproduction
and recorded execution. Unit tests are not on-chain transaction evidence.

- [`src/`](src/): state machine, account decoder and read-only verifier.
- [`programs/escrowed/`](programs/escrowed/): Anchor contract.
- [`web/`](web/): devnet application and reusable chain client.
- [`scripts/`](scripts/): IDL generation and runtime checks.
- [`artifacts/idl/`](artifacts/idl/): IDL generated from the Anchor implementation.
- [Program limits and hardening](programs/escrowed/SECURITY-NOTES.md).

Program ID: `EetC1jU5Zd686oKr7PuWG23Bfa6kjRuok2gCqxNZ5XPE`.

## Provenance

The original Rust state machine, decoder and Anchor wrapper predate October 1,
2026. The October 1 completion adds the web flow, a stricter verifier, destination
and balance safeguards, consistent IDL and runtime evidence. Development and
review use AI assistance. No users, payouts, adoption or security certification
are claimed from synthetic fixtures or test-network transactions.

Apache-2.0. Financial receipts and grant application data stay outside this repo.
