# What this program proves

Escrowed is a prototype escrow for native SOL. A successful `create_bounty`
transfers the stated lamports to a program-owned PDA. The account binds the
sponsor, a 32-byte bounty identifier, amount, deadline and lifecycle state.
The application convention is SHA-256 of the exact listing URL; the contract
does not crawl that URL or certify its author.

The sponsor alone may award a funded escrow, including after the deadline.
Anyone can refund an unawarded escrow at or after the deadline, but the funds
return to the sponsor, not the caller or a worker. An award and a refund are
mutually exclusive terminal transitions. Account rent remains in the settled
PDA so its historical status stays available.

This is not a guarantee that a worker will be paid, selected fairly, or reimbursed
for effort. Rejecting the sponsor's exact public key as winner does not prevent
the same person using another wallet. A late award races with an eligible refund;
the first confirmed transition determines the outcome. No dispute resolution,
proof of work quality, or fiat/stablecoin protection is provided. A deployed
upgradeable program can be changed by its upgrade authority. These limitations
must remain visible in the product and grant description.

## Checks before publication

- Verify the deployed program ID and executable program account; do not infer a
  deployment from the presence of a compiled binary or generated IDL.
- Verify account owner, discriminator, canonical PDA, sponsor, bounty identifier,
  stored amount, account balance, rent reserve, state and deadline together.
  An Anchor discriminator is a public format tag, not proof of ownership.
- Report the observed network and slot. A funded observation is a snapshot,
  not a promise that funds will still be available later.
- Exercise create, award, refund and rejected transitions on the actual SBF.
  Host unit tests do not exercise account constraints, CPI or runtime rules.
- Generate the IDL from the same source revision and reconcile deployment
  artifacts, evidence and public client against it.

## October 1 hardening

The previous transfer code allowed the escrow account itself to be selected as
winner. Debit and credit then targeted the same account; state became awarded
without a prize leaving, leaving the funds inaccessible to normal settlement.
`transfer_prize` now rejects that account and executable recipients. It validates
both resulting balances before changing either one, uses checked arithmetic,
and preserves the rent reserve. Five host regression tests cover these cases;
the local-validator script also includes the escrow-recipient rejection.

This review is scoped engineering work, not an independent security audit or a
statement that the prototype is appropriate for holding real funds.
