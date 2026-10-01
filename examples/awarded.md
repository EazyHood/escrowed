# Escrowed devnet example: awarded receipt

[Open this exact example in the verifier](https://eazyhood.github.io/escrowed/?listing=https%3A%2F%2Fgithub.com%2FEazyHood%2Fescrowed%2Fblob%2Fmain%2Fexamples%2Fawarded.md&sponsor=3rfnzNgH7v2y9uoz2ExEmw3QLzpzD6TBpejLKo7pUeqv).

This is a **demonstration fixture, not a real bounty award**. Its intended prize
is **0.001 devnet SOL**, sent to a separate test wallet controlled for the demo.
The recipient is not an outside winner, customer or worker.

- Exact listing identity: `https://github.com/EazyHood/escrowed/blob/main/examples/awarded.md`
- Sponsor test wallet: `3rfnzNgH7v2y9uoz2ExEmw3QLzpzD6TBpejLKo7pUeqv`
- Network: Solana devnet.
- Program: `EetC1jU5Zd686oKr7PuWG23Bfa6kjRuok2gCqxNZ5XPE`.

The runner creates and funds the escrow, then signs an award from the sponsor.
It checks that the separate recipient receives exactly the stated prize and
that the account becomes Awarded. The rent reserve remains in the escrow to
preserve the receipt; the settled prize is not still available for another
award or refund.

Verify the current state in [Escrowed](https://eazyhood.github.io/escrowed/) using
the exact URL and sponsor above. Do not infer execution from this explanatory
page: [the transaction report](../artifacts/evidence/devnet-examples.json) must
show confirmed real devnet signatures, account observations and recipient
balance evidence. If that report is missing or incomplete, this page only
describes the fixture's intended workflow.

Code: [devnet-examples.mjs](../scripts/devnet-examples.mjs).
Limits: [SECURITY-NOTES.md](../programs/escrowed/SECURITY-NOTES.md).
No earnings, fair selection or mainnet security are claimed by this example.
