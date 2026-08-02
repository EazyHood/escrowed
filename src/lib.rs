//! Escrowed — the state machine behind a bounty escrow.
//!
//! A sponsor locks the prize *before* publishing the bounty. Anyone can then
//! check on-chain whether the money is really there, instead of taking the
//! listing's word for it. The sponsor awards a winner; if the deadline passes
//! unawarded, the hunter can force a refund.
//!
//! This module is deliberately free of Solana types. Every rule that decides
//! whether funds move lives here, so the transitions — including the ones that
//! must be *refused* — are testable with plain `cargo test`, with no validator,
//! no keypairs and no toolchain. The Anchor program is a thin shell that
//! resolves accounts and calls into this.
//!
//! Why that split matters: escrow bugs are not caught by the happy path. They
//! are caught by asking whether awarding twice, refunding early, or awarding
//! after a refund can be made to work. Those are cheap to test here and
//! expensive to test through a validator.

/// Who is asking for a transition. The program derives this from signatures;
/// the state machine only needs to know which role it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor {
    Sponsor,
    Other,
}

/// Lifecycle of one escrowed bounty. Terminal states are terminal: once funds
/// have left, no further transition may move them again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Funded and open. The only state from which money can still move.
    Funded,
    /// Paid to a winner. Terminal.
    Awarded,
    /// Returned to the sponsor after the deadline. Terminal.
    Refunded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscrowError {
    /// A non-sponsor tried to award.
    NotSponsor,
    /// The escrow is already Awarded or Refunded.
    AlreadySettled,
    /// Refund attempted while the bounty is still open.
    DeadlineNotReached,
    /// create_bounty called with nothing in it.
    ZeroAmount,
    /// create_bounty called with a deadline that is already in the past.
    DeadlineInPast,
    /// Awarding to the sponsor's own address.
    SelfAward,
}

/// One escrowed bounty. `amount` never changes after creation; the status is
/// what decides where it can go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Escrow {
    pub sponsor: [u8; 32],
    pub amount: u64,
    /// Unix seconds. After this, an unawarded escrow can be refunded.
    pub deadline: i64,
    pub status: Status,
    /// Set only on a successful award.
    pub winner: Option<[u8; 32]>,
}

/// Where funds should end up as a result of a transition. Returned rather than
/// performed, so the caller (the Anchor program) owns the transfer and this
/// stays pure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Payout {
    pub to: [u8; 32],
    pub amount: u64,
}

impl Escrow {
    /// Lock `amount` until `deadline`.
    ///
    /// Rejects a zero amount and a deadline already in the past: both produce an
    /// escrow that looks funded in a listing while guaranteeing nothing, which
    /// is precisely the failure this program exists to prevent.
    pub fn create(
        sponsor: [u8; 32],
        amount: u64,
        deadline: i64,
        now: i64,
    ) -> Result<Self, EscrowError> {
        if amount == 0 {
            return Err(EscrowError::ZeroAmount);
        }
        if deadline <= now {
            return Err(EscrowError::DeadlineInPast);
        }
        Ok(Self {
            sponsor,
            amount,
            deadline,
            status: Status::Funded,
            winner: None,
        })
    }

    /// Pay the winner. Only the sponsor may call this, only once, and not to
    /// themselves.
    ///
    /// Deliberately allowed *after* the deadline: a late award is still the
    /// sponsor honouring the bounty, and refusing it would strand funds whenever
    /// judging ran long. The refund path is what protects the hunter from a
    /// sponsor who never awards at all.
    pub fn award(
        &mut self,
        caller: Actor,
        winner: [u8; 32],
    ) -> Result<Payout, EscrowError> {
        if self.status != Status::Funded {
            return Err(EscrowError::AlreadySettled);
        }
        if caller != Actor::Sponsor {
            return Err(EscrowError::NotSponsor);
        }
        if winner == self.sponsor {
            return Err(EscrowError::SelfAward);
        }
        self.status = Status::Awarded;
        self.winner = Some(winner);
        Ok(Payout {
            to: winner,
            amount: self.amount,
        })
    }

    /// Return the funds to the sponsor once the deadline has passed without an
    /// award.
    ///
    /// Intentionally callable by anyone, not just the sponsor: the point is that
    /// the money cannot be held hostage. A sponsor who stops responding cannot
    /// leave it locked, and since the funds can only ever go back to the sponsor
    /// there is nothing for a third-party caller to gain by triggering it.
    pub fn refund(&mut self, now: i64) -> Result<Payout, EscrowError> {
        if self.status != Status::Funded {
            return Err(EscrowError::AlreadySettled);
        }
        if now < self.deadline {
            return Err(EscrowError::DeadlineNotReached);
        }
        self.status = Status::Refunded;
        Ok(Payout {
            to: self.sponsor,
            amount: self.amount,
        })
    }

    /// What a hunter checks before starting work: is the money actually here?
    pub fn is_funded(&self) -> bool {
        self.status == Status::Funded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPONSOR: [u8; 32] = [1u8; 32];
    const WINNER: [u8; 32] = [2u8; 32];
    const STRANGER: [u8; 32] = [3u8; 32];
    const NOW: i64 = 1_000;
    const DEADLINE: i64 = 2_000;

    fn funded() -> Escrow {
        Escrow::create(SPONSOR, 500, DEADLINE, NOW).expect("valid escrow")
    }

    // ---- creation ----

    #[test]
    fn create_locks_the_amount_and_opens_the_bounty() {
        let e = funded();
        assert_eq!(e.amount, 500);
        assert_eq!(e.status, Status::Funded);
        assert!(e.is_funded());
        assert_eq!(e.winner, None);
    }

    #[test]
    fn create_rejects_a_zero_amount() {
        assert_eq!(
            Escrow::create(SPONSOR, 0, DEADLINE, NOW),
            Err(EscrowError::ZeroAmount)
        );
    }

    #[test]
    fn create_rejects_a_deadline_already_past() {
        assert_eq!(
            Escrow::create(SPONSOR, 500, NOW - 1, NOW),
            Err(EscrowError::DeadlineInPast)
        );
        // Equal to now is also refused: it would be refundable in the same slot.
        assert_eq!(
            Escrow::create(SPONSOR, 500, NOW, NOW),
            Err(EscrowError::DeadlineInPast)
        );
    }

    // ---- the happy paths ----

    #[test]
    fn sponsor_awards_the_winner() {
        let mut e = funded();
        let payout = e.award(Actor::Sponsor, WINNER).expect("award succeeds");
        assert_eq!(payout, Payout { to: WINNER, amount: 500 });
        assert_eq!(e.status, Status::Awarded);
        assert_eq!(e.winner, Some(WINNER));
        assert!(!e.is_funded());
    }

    #[test]
    fn anyone_can_refund_once_the_deadline_passes() {
        let mut e = funded();
        let payout = e.refund(DEADLINE).expect("refund succeeds at the deadline");
        assert_eq!(payout, Payout { to: SPONSOR, amount: 500 });
        assert_eq!(e.status, Status::Refunded);
    }

    // ---- the paths that must be refused ----

    #[test]
    fn a_stranger_cannot_award() {
        let mut e = funded();
        assert_eq!(e.award(Actor::Other, STRANGER), Err(EscrowError::NotSponsor));
        assert_eq!(e.status, Status::Funded, "a refused award must not settle it");
    }

    #[test]
    fn awarding_twice_pays_once() {
        let mut e = funded();
        e.award(Actor::Sponsor, WINNER).expect("first award");
        assert_eq!(
            e.award(Actor::Sponsor, STRANGER),
            Err(EscrowError::AlreadySettled)
        );
        assert_eq!(e.winner, Some(WINNER), "the first winner stands");
    }

    #[test]
    fn refunding_before_the_deadline_is_refused() {
        let mut e = funded();
        assert_eq!(e.refund(DEADLINE - 1), Err(EscrowError::DeadlineNotReached));
        assert_eq!(e.status, Status::Funded);
    }

    #[test]
    fn refunding_after_an_award_is_refused() {
        let mut e = funded();
        e.award(Actor::Sponsor, WINNER).expect("award");
        // Well past the deadline — the escrow is still settled, so no second payout.
        assert_eq!(e.refund(DEADLINE + 10_000), Err(EscrowError::AlreadySettled));
    }

    #[test]
    fn awarding_after_a_refund_is_refused() {
        let mut e = funded();
        e.refund(DEADLINE).expect("refund");
        assert_eq!(
            e.award(Actor::Sponsor, WINNER),
            Err(EscrowError::AlreadySettled)
        );
    }

    #[test]
    fn refunding_twice_pays_once() {
        let mut e = funded();
        e.refund(DEADLINE).expect("first refund");
        assert_eq!(e.refund(DEADLINE), Err(EscrowError::AlreadySettled));
    }

    #[test]
    fn the_sponsor_cannot_award_themselves() {
        let mut e = funded();
        assert_eq!(e.award(Actor::Sponsor, SPONSOR), Err(EscrowError::SelfAward));
        assert_eq!(e.status, Status::Funded);
    }

    // ---- the property that matters ----

    #[test]
    fn funds_leave_at_most_once_under_any_ordering() {
        // Every ordering of the four calls, against a fresh escrow each time.
        // Whatever the sequence, at most one payout may be produced.
        let ops: [&str; 4] = ["award_sponsor", "award_other", "refund_early", "refund_late"];
        for a in ops {
            for b in ops {
                for c in ops {
                    let mut e = funded();
                    let mut payouts = 0;
                    for op in [a, b, c] {
                        let r = match op {
                            "award_sponsor" => e.award(Actor::Sponsor, WINNER).ok(),
                            "award_other" => e.award(Actor::Other, STRANGER).ok(),
                            "refund_early" => e.refund(DEADLINE - 1).ok(),
                            "refund_late" => e.refund(DEADLINE).ok(),
                            _ => None,
                        };
                        if let Some(p) = r {
                            payouts += 1;
                            assert_eq!(p.amount, 500, "a payout is always the full amount");
                        }
                    }
                    assert!(
                        payouts <= 1,
                        "sequence {a} -> {b} -> {c} produced {payouts} payouts"
                    );
                }
            }
        }
    }
}
