# Deploying to devnet

Everything below the toolchain line is already done and tested with plain
`cargo test`; this file is only about getting the program onto devnet.

## What is already verified

```
cargo test                                          # 22 passing — the state machine
cargo test --no-default-features                    # 20 passing — as the program sees it
cargo test --manifest-path programs/escrowed/Cargo.toml   # 3 passing — layout guard + PDA
```

The last one matters most. `EscrowAccount::SPACE` and `escrowed_core::decode::ACCOUNT_LEN`
are two spellings of one layout; the guard asserts they are equal, and it was
checked by breaking it on purpose (it reported `left: 90, right: 122`).

## The toolchain

Anchor does not build on native Windows. Use WSL with a real distribution:

```bash
wsl --install -d Ubuntu
```

then inside it:

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.31.1 && avm use 0.31.1
```

## Deploy

```bash
solana-keygen new -o ~/.config/solana/id.json     # a throwaway deploy key, not your wallet
solana config set --url devnet
solana airdrop 2                                  # devnet SOL is free
anchor build
anchor keys sync                                  # REQUIRED: writes the real program id
anchor build                                      # rebuild so declare_id! matches
anchor deploy --provider.cluster devnet
```

`anchor keys sync` is not optional. The `declare_id!` in `programs/escrowed/src/lib.rs`
and the ids in `Anchor.toml` are a placeholder (`Esc1owed…`) that nobody holds the
key for. Deploying before syncing puts the program at an address its own code
does not recognise, and every PDA check fails at runtime.

## Note on the deploy key

Use a fresh keypair for deploying, not the wallet that holds real funds. The
deploy authority can upgrade the program; there is no reason for it to be the
same key that receives money.
