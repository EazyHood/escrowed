# Escrowed

**Bounties that prove the money exists before anyone works for free.**

A sponsor locks the prize *before* publishing the bounty. Anyone can then check
on-chain whether the funds are really there, instead of taking the listing's word
for it. The sponsor awards a winner; if the deadline passes unawarded, the hunter
can force a refund.

## Why

Hunting funded open-source work for two days produced this:

| repo | advertised | reality |
|---|---|---|
| `claude-builders-bounty` | $50–200 per task | **3,431 PRs received, 0 merged** |
| `xevrion-v2/agent-playground` | $1,000 | 271 stars, **0 merged PRs** |
| IssueHunt (whole platform) | a bounty marketplace | **18 funded issues**, 16 from 2023–24 |

None of that is visible from the listing. You find out after the work is done.

The first design here was to verify *backwards* — join announced winners on
Superteam Earn against on-chain transfers. Before building it I checked whether
the data existed. It does not: the public winner records expose `userId`, name
and photo, and **no wallet address anywhere**. So that plan was dropped.

That dead end is what produced this one. If the past cannot be verified, make the
future verifiable.

## The shape of it

```
create_bounty(amount, deadline)   sponsor locks funds in a PDA
award(winner)                     sponsor releases to the winner
refund()                          anyone, after the deadline, returns to sponsor
```

The guarantee is the chain itself. There is no server to trust about whether the
money is there — there is an account with a balance that anyone can read.

## Where the logic lives

`escrowed-core` holds every rule that decides whether funds move, with no Solana
types in it. That is on purpose: escrow bugs are not found on the happy path,
they are found by asking whether you can award twice, refund early, or award
after a refund. Those questions are cheap to answer with `cargo test` and
expensive to answer through a validator.

```bash
cargo test
```

```
running 20 tests
test tests::a_stranger_cannot_award ... ok
test tests::awarding_twice_pays_once ... ok
test tests::refunding_twice_pays_once ... ok
test tests::refunding_before_the_deadline_is_refused ... ok
test tests::refunding_after_an_award_is_refused ... ok
test tests::awarding_after_a_refund_is_refused ... ok
test tests::the_sponsor_cannot_award_themselves ... ok
test tests::funds_leave_at_most_once_under_any_ordering ... ok
test decode::tests::rejects_an_account_belonging_to_another_program ... ok
test decode::tests::a_zero_amount_is_never_reported_as_funded ... ok
test decode::tests::extra_trailing_bytes_do_not_shift_the_fields ... ok
...
test result: ok. 20 passed; 0 failed

running 5 tests
test tests::base64_round_trips_known_vectors ... ok
test tests::rejects_a_discriminator_of_the_wrong_length ... ok
...
test result: ok. 5 passed; 0 failed
```

**25 in total** — 20 over the state machine and the account decoder, 5 over the
`verify` binary's own parsing. The suite runs with no network and no validator:
every rule that decides whether funds move lives in a crate with no Solana types
in it, so the refusals above are checked by `cargo test` rather than promised.

The last one is the property that matters: it runs **every ordering** of award
and refund calls against a fresh escrow and asserts that at most one payout is
ever produced.

## Two decisions worth arguing with

**Awarding is allowed after the deadline.** A late award is still the sponsor
honouring the bounty, and refusing it would strand funds whenever judging ran
long. The refund path — not a deadline on awarding — is what protects the hunter
from a sponsor who never awards at all.

**Refund is callable by anyone, not just the sponsor.** The point is that funds
cannot be held hostage: a sponsor who stops responding cannot leave them locked.
Since a refund can only ever return money to the sponsor, a third-party caller
has nothing to gain by triggering it.

## Status

The state machine is complete and tested. The Anchor wrapper and devnet
deployment are next — that is a thin shell that resolves accounts and calls into
this crate, so the interesting logic is already the part you can run.

Apache-2.0.
