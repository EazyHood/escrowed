# Escrowed devnet example: funded receipt

[Open this exact example in the verifier](https://eazyhood.github.io/escrowed/?listing=https%3A%2F%2Fgithub.com%2FEazyHood%2Fescrowed%2Fblob%2Fmain%2Fexamples%2Ffunded.md&sponsor=3rfnzNgH7v2y9uoz2ExEmw3QLzpzD6TBpejLKo7pUeqv).

This is a **demonstration fixture, not an open paid bounty**. Do not perform work
expecting a prize. Its intended escrow amount is **0.001 devnet SOL**, which is
a test-network asset with no monetary award attached.

- Exact listing identity: `https://github.com/EazyHood/escrowed/blob/main/examples/funded.md`
- Sponsor test wallet: `3rfnzNgH7v2y9uoz2ExEmw3QLzpzD6TBpejLKo7pUeqv`
- Network: Solana devnet.
- Program: `EetC1jU5Zd686oKr7PuWG23Bfa6kjRuok2gCqxNZ5XPE`.

Open [Escrowed](https://eazyhood.github.io/escrowed/), enter this exact listing
URL and sponsor address, and verify the current account. The app derives the
PDA from the program, sponsor and SHA-256 of the exact URL. It checks ownership,
format, identity, lifecycle state, balance and rent reserve at a reported slot.

The fixture is intended to remain funded for up to 30 days after creation.
Its present status can change. A document or screenshot is not proof that funds
are still available; use the current devnet read. If the account has not yet
been created, the correct result is that no matching escrow is present.

The reproducible runner is [devnet-examples.mjs](../scripts/devnet-examples.mjs).
When executed successfully, its [public transaction report](../artifacts/evidence/devnet-examples.json)
records the real signatures and observed states. A missing or incomplete
report means execution is not established. The local-validator evidence is a
different test and must not be described as devnet publication.

Funded backing does not guarantee a worker will be selected or paid. The sponsor
selects the winner; after the deadline, a caller can return an unawarded prize
to the sponsor. Read the [scope and limitations](../programs/escrowed/SECURITY-NOTES.md).
