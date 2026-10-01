# Escrowed devnet example: refunded receipt

[Open this exact example in the verifier](https://eazyhood.github.io/escrowed/?listing=https%3A%2F%2Fgithub.com%2FEazyHood%2Fescrowed%2Fblob%2Fmain%2Fexamples%2Frefunded.md&sponsor=3rfnzNgH7v2y9uoz2ExEmw3QLzpzD6TBpejLKo7pUeqv).

This is a **demonstration fixture using 0.001 devnet SOL**, not a reimbursement
of a worker or a real-currency payment.

- Exact listing identity: `https://github.com/EazyHood/escrowed/blob/main/examples/refunded.md`
- Sponsor test wallet: `3rfnzNgH7v2y9uoz2ExEmw3QLzpzD6TBpejLKo7pUeqv`
- Network: Solana devnet.
- Program: `EetC1jU5Zd686oKr7PuWG23Bfa6kjRuok2gCqxNZ5XPE`.

The runner funds this escrow with a short future deadline, waits for the
devnet clock to reach it, and requests a refund from a **different test wallet**.
It checks that exactly the prize goes back to the sponsor, while the separate
caller pays the transaction fee. The account should then be Refunded, with
its rent reserve retained for the historical receipt.

The caller does not receive the prize. This example demonstrates permissionless
triggering of the sponsor's refund, not compensation for a participant's work.

Verify the present account in [Escrowed](https://eazyhood.github.io/escrowed/)
using the exact URL and sponsor above. Actual execution requires a confirmed
[public report](../artifacts/evidence/devnet-examples.json), including signatures,
the deadline and sponsor balance changes. A missing or incomplete report means
the demonstration has not been established. This page alone is not evidence
of a completed transaction.

Code: [devnet-examples.mjs](../scripts/devnet-examples.mjs).
Limits: [SECURITY-NOTES.md](../programs/escrowed/SECURITY-NOTES.md).
