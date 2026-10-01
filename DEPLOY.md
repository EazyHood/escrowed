# Build, execution evidence and devnet deployment

The October 1, 2026 build executes on a **local Solana validator**. Public
devnet deployment is a separate step and must have its own transaction receipt.
A compiled binary, local transaction or web build does not prove public deployment.

## Reproduce the checks

From the repository root:

```sh
cargo test --locked
cargo test --locked --no-default-features
cargo test --locked --manifest-path programs/escrowed/Cargo.toml
npm ci --prefix web
npm test --prefix web
npm run build --prefix web
```

On October 1, the Rust checks passed 28 library + 2 CLI tests, 22 tests without
the network feature, and 9 Anchor host tests. The no-network tests overlap with
the library tests; do not add them together as distinct coverage.

Use the official, pinned Anchor container for SBF compilation on Windows or
Linux. The same commands are recorded in
[the program workflow](.github/workflows/program.yml):

```sh
docker run --rm -v "$PWD:/work" -w /work \
  solanafoundation/anchor:v0.31.1@sha256:21ab8a16e19df4301a198d7a55ab2988549aa2d996e6b5ad229c1d95b9f2d326 \
  bash -lc 'cd programs/escrowed && cargo build-sbf -- --locked'
```

For PowerShell, pass the repository's absolute path as the mount source and use
one line or PowerShell continuation syntax. The program is a detached Cargo
workspace; its output is `programs/escrowed/target/deploy/escrowed.so`, not the
root `target` directory. Keep the program lockfile: the pinned SBF toolchain uses
Rust 1.79 and cannot compile newer transitive releases selected by an unreviewed
lockfile regeneration.

The recorded binary is 219,680 bytes with SHA-256
`9bff5f8120bf7dfff93b9472f3ce9cd9ee6e768f66b04a2ba82c05b0deb5da9b`.
See [the build manifest](artifacts/evidence/build-manifest.json) for the toolchain
and source hashes. Any program change requires a fresh build and evidence.

The IDL is generated from Anchor's IDL builder, not maintained by hand:

```sh
cargo run --locked --manifest-path scripts/chain-idl/Cargo.toml -- "$PWD"
```

The generator requires an absolute repository path. In PowerShell replace
`"$PWD"` with `(Get-Location).Path`.

## Local runtime evidence

The program workflow starts `solana-test-validator` with the newly compiled SBF
at the declared program address, then runs `scripts/chain-smoke.mjs`. This script
accepts only a loopback RPC and creates disposable in-memory test wallets. Run
it with `ESCROWED_NODE_PACKAGE` pointing to the absolute `web/package.json` path.

[The runtime report](artifacts/evidence/local-validator.json) records **18
confirmed local transactions: 8 successful and 10 expected rejections**. Two of
the successes fund disposable wallets; six execute escrow lifecycle actions.
[The transaction export](artifacts/evidence/local-transactions.json) preserves
their results. These exercise deposit, award, refund to the sponsor, unauthorized
and repeated settlements, early refund, invalid amounts/deadlines and a
self-recipient alias. These are local test assets and synthetic listings, not
users, real payouts or an independent security audit.

## Public devnet

The deployment uses the program ID
`EetC1jU5Zd686oKr7PuWG23Bfa6kjRuok2gCqxNZ5XPE` and test deployer
`3rfnzNgH7v2y9uoz2ExEmw3QLzpzD6TBpejLKo7pUeqv`. The deployer is a separate
test wallet, **not the grant payment wallet**. Both private key files stay
outside this repository. Never publish them or put them in a browser bundle.

Before deployment:

1. Confirm endpoint `https://api.devnet.solana.com` and genesis
   `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
2. Verify public keys of the intended key files without printing secrets.
   Verify the binary hash against the build manifest.
3. Obtain free test SOL from the [official faucet](https://faucet.solana.com).
   Inspect current rent and balance; reserves depend on binary allocation.
   A faucet request is not proof of credited funds.
4. Deploy with an explicit RPC, keypair, program keypair and upgrade authority.
   Keep a resumable buffer key outside the repo. Never rely on a user's
   default CLI network or wallet.
5. Record the confirmed signature, program/program-data accounts and authority.
   Read back executable state and compare a dumped deployed binary with the
   reviewed build, accounting for allocation padding.
6. Execute real devnet examples and read them back through the shared web client.
   Only then publish those examples as live evidence.

Example command structure (replace paths with your private files):

```sh
solana program deploy programs/escrowed/target/deploy/escrowed.so \
  --url https://api.devnet.solana.com \
  --keypair /private/deployer.json \
  --program-id /private/escrowed-program-keypair.json \
  --upgrade-authority /private/deployer.json \
  --buffer /private/deploy-buffer.json \
  --use-rpc --max-sign-attempts 5 --output json
```

This is an upgradeable, unaudited devnet prototype. Do not deploy this version
to mainnet or use assets with monetary value. The web client rejects a different
genesis before its transaction workflows.

## Public website

The [Pages workflow](.github/workflows/pages.yml) tests and builds `web/` on
changes to `main`, then publishes the static bundle through GitHub Pages.
Configure the repository's Pages build source as GitHub Actions. The site base
is `/escrowed/`. Verify the actual public URL after a successful workflow;
an unpushed build is not a published app.

The website contains no private keys, receipts or grant application data. Those
documents belong exclusively in the authorized private grant submission.
