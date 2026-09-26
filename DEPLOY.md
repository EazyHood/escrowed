# Deploying to devnet

The state machine, the account decoder and the on-chain program all build and
test; this file is only about getting the compiled program onto devnet.

## What is already verified

Inside the official Anchor image (`solanafoundation/anchor:v0.31.1`, which ships
anchor-cli 0.31.1 / solana-cli 2.1.0):

```
cargo test                                                # 22 passing — the state machine
cargo test --no-default-features                          # 20 passing — as the program sees it
cargo test --manifest-path programs/escrowed/Cargo.toml   #  3 passing — layout guard + PDA
cargo build-sbf   (in programs/escrowed)                  # -> target/deploy/escrowed.so, 214 KB
anchor build                                              # -> target/idl/escrowed.json
```

The layout guard matters most. `EscrowAccount::SPACE` and
`escrowed_core::decode::ACCOUNT_LEN` are two spellings of one layout; the guard
asserts they are equal, and it was checked by breaking it on purpose (it
reported `left: 90, right: 122`).

## The toolchain — Docker, no WSL needed

Anchor does not build on native Windows, but the official image builds it
without installing anything. From the repo root:

```bash
docker run --rm -v "/c/Users/jhona/claude 4/escrowed:/work" -w /work \
  solanafoundation/anchor:v0.31.1 \
  bash -lc 'cd programs/escrowed && cargo build-sbf'
```

(On Git Bash prefix the command with `MSYS_NO_PATHCONV=1` so the `-v` path is
not mangled.) The compiled program lands at
`programs/escrowed/target/deploy/escrowed.so` — note it is under the program's
own target, not the workspace root, because `programs/escrowed` is a detached
workspace.

### Why the lockfile is pinned

`programs/escrowed/Cargo.lock` pins blake3 1.5.5, zeroize 1.8.1,
proc-macro-crate 3.2.0, indexmap 2.9.0 and unicode-segmentation 1.12.0. The SBF
toolchain ships cargo 1.79, and a fresh resolution pulls transitive crates that
need `edition2024` or rustc ≥ 1.85, which that cargo cannot build. Do not delete
or regenerate the lockfile without re-pinning, or the build breaks again.

## Program id

`declare_id!` and `Anchor.toml` are set to
`EetC1jU5Zd686oKr7PuWG23Bfa6kjRuok2gCqxNZ5XPE`. The matching keypair is kept
**outside the repo**, in `../escrowed-devnet-keys/escrowed-program-keypair.json`.
Deploying with that keypair claims exactly this address, so no `anchor keys sync`
is needed anymore. (For a different id, `solana-keygen new -o
new-keypair.json`, then set its pubkey in both files and rebuild.)

## Deploy

The one thing missing is devnet SOL for the deployer. The CLI faucet
(`solana airdrop`) is rate-limited and currently refuses from shared IPs; when
it does, fund the deployer from the web faucet instead:
<https://faucet.solana.com> — paste the deployer address, which is
`3rfnzNgH7v2y9uoz2ExEmw3QLzpzD6TBpejLKo7pUeqv` (keypair in
`../escrowed-devnet-keys/deployer.json`). A 214 KB program needs about 3 SOL of
rent-exempt reserve.

Once the deployer holds ~3 SOL, deploy in one command:

```bash
docker run --rm \
  -v "/c/Users/jhona/claude 4/escrowed:/work" \
  -v "/c/Users/jhona/claude 4/escrowed-devnet-keys:/keys" -w /work \
  solanafoundation/anchor:v0.31.1 \
  bash -lc 'solana config set --url devnet --keypair /keys/deployer.json &&
    solana program deploy programs/escrowed/target/deploy/escrowed.so \
      --program-id /keys/escrowed-program-keypair.json'
```

## Note on the keys

Two separate keypairs, both in `../escrowed-devnet-keys/` (never committed):

- `escrowed-program-keypair.json` — only claims the program address at first
  deploy; its pubkey is the program id above.
- `deployer.json` — pays for the deploy and becomes the upgrade authority. It is
  a throwaway devnet key, not the wallet that receives grant funds.
