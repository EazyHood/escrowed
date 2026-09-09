//! Decoding an escrow account straight from its bytes.
//!
//! This is what `escrowed verify` runs on whatever `getAccountInfo` returns. It
//! is deliberately separate from any HTTP: the parsing is the part that can be
//! wrong in a way that matters — reading a stale layout, or trusting an account
//! that belongs to a different program — and it is testable without a network,
//! a validator, or a deployed program.
//!
//! Layout, matching `EscrowAccount` in the Anchor program:
//!
//! ```text
//! offset  size  field
//!      0     8  anchor discriminator
//!      8    32  sponsor pubkey
//!     40    32  bounty_id (sha256 of the listing URL)
//!     72     8  amount (u64 LE)
//!     80     8  deadline (i64 LE)
//!     88     1  status (0 funded, 1 awarded, 2 refunded)
//!     89    32  winner pubkey (all-zero until awarded)
//!    121     1  bump
//! ```
//!
//! The program's `EscrowAccount::SPACE` and `ACCOUNT_LEN` here are two spellings
//! of one layout, and they are asserted equal by a test in the program crate. A
//! decoder that silently reads a stale layout is worse than one that refuses:
//! it reports a confident, wrong answer about whether money is locked.

use crate::Status;

pub const DISCRIMINATOR_LEN: usize = 8;
pub const ACCOUNT_LEN: usize = 122;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    /// Fewer bytes than the layout needs. A truncated account is not a funded one.
    TooShort { got: usize },
    /// The leading 8 bytes are not this account type's discriminator. Without
    /// this check any account of the right size would decode into a plausible
    /// escrow, which is exactly how a fake "funded" bounty would be built.
    WrongDiscriminator,
    /// Status byte outside the known set.
    UnknownStatus(u8),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedEscrow {
    pub sponsor: [u8; 32],
    /// Which bounty this escrow backs. A verifier hashes the listing URL and
    /// compares, so an escrow cannot be waved at a listing it does not fund.
    pub bounty_id: [u8; 32],
    pub amount: u64,
    pub deadline: i64,
    pub status: Status,
    pub winner: Option<[u8; 32]>,
    pub bump: u8,
}

impl DecodedEscrow {
    /// The question a hunter is actually asking.
    pub fn is_funded(&self) -> bool {
        self.status == Status::Funded && self.amount > 0
    }
}

/// Decode account data, rejecting anything that is not this exact account type.
///
/// `expected_discriminator` is the program's own 8-byte tag. It is a parameter
/// rather than a constant so the caller can pin the deployed program's value and
/// a mismatch is a hard error instead of a silent misread.
pub fn decode_escrow(
    data: &[u8],
    expected_discriminator: &[u8; DISCRIMINATOR_LEN],
) -> Result<DecodedEscrow, DecodeError> {
    if data.len() < ACCOUNT_LEN {
        return Err(DecodeError::TooShort { got: data.len() });
    }
    if &data[0..DISCRIMINATOR_LEN] != expected_discriminator.as_slice() {
        return Err(DecodeError::WrongDiscriminator);
    }

    let mut sponsor = [0u8; 32];
    sponsor.copy_from_slice(&data[8..40]);

    let mut bounty_id = [0u8; 32];
    bounty_id.copy_from_slice(&data[40..72]);

    let amount = u64::from_le_bytes(data[72..80].try_into().expect("8 bytes"));
    let deadline = i64::from_le_bytes(data[80..88].try_into().expect("8 bytes"));

    let status = match data[88] {
        0 => Status::Funded,
        1 => Status::Awarded,
        2 => Status::Refunded,
        other => return Err(DecodeError::UnknownStatus(other)),
    };

    let mut winner_raw = [0u8; 32];
    winner_raw.copy_from_slice(&data[89..121]);
    // The program writes an all-zero pubkey until an award happens, so that is
    // "no winner" rather than a winner whose key happens to be zero.
    let winner = if winner_raw == [0u8; 32] { None } else { Some(winner_raw) };

    Ok(DecodedEscrow {
        sponsor,
        bounty_id,
        amount,
        deadline,
        status,
        winner,
        bump: data[121],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DISC: [u8; 8] = [11, 22, 33, 44, 55, 66, 77, 88];
    const SPONSOR: [u8; 32] = [7u8; 32];
    const WINNER: [u8; 32] = [9u8; 32];
    const BOUNTY: [u8; 32] = [3u8; 32];

    /// Build account bytes the way the program would write them.
    fn encode(amount: u64, deadline: i64, status: u8, winner: [u8; 32], disc: [u8; 8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(ACCOUNT_LEN);
        v.extend_from_slice(&disc);
        v.extend_from_slice(&SPONSOR);
        v.extend_from_slice(&BOUNTY);
        v.extend_from_slice(&amount.to_le_bytes());
        v.extend_from_slice(&deadline.to_le_bytes());
        v.push(status);
        v.extend_from_slice(&winner);
        v.push(254); // bump
        v
    }

    #[test]
    fn decodes_a_funded_escrow() {
        let raw = encode(1_500_000, 1_900_000_000, 0, [0u8; 32], DISC);
        let e = decode_escrow(&raw, &DISC).expect("decodes");
        assert_eq!(e.sponsor, SPONSOR);
        assert_eq!(e.bounty_id, BOUNTY);
        assert_eq!(e.amount, 1_500_000);
        assert_eq!(e.deadline, 1_900_000_000);
        assert_eq!(e.status, Status::Funded);
        assert_eq!(e.winner, None);
        assert_eq!(e.bump, 254);
        assert!(e.is_funded());
    }

    #[test]
    fn decodes_an_awarded_escrow_with_its_winner() {
        let raw = encode(1_500_000, 1_900_000_000, 1, WINNER, DISC);
        let e = decode_escrow(&raw, &DISC).expect("decodes");
        assert_eq!(e.status, Status::Awarded);
        assert_eq!(e.winner, Some(WINNER));
        assert!(!e.is_funded(), "an awarded escrow is not still funded");
    }

    #[test]
    fn rejects_an_account_belonging_to_another_program() {
        // Same size, same shape, different tag. Without the discriminator check
        // this would decode as a perfectly plausible funded bounty.
        let raw = encode(999_999, 1_900_000_000, 0, [0u8; 32], [1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(
            decode_escrow(&raw, &DISC),
            Err(DecodeError::WrongDiscriminator)
        );
    }

    #[test]
    fn rejects_a_truncated_account() {
        let raw = encode(1, 2, 0, [0u8; 32], DISC);
        for cut in [0usize, 8, 40, 72, 88, ACCOUNT_LEN - 1] {
            assert_eq!(
                decode_escrow(&raw[..cut], &DISC),
                Err(DecodeError::TooShort { got: cut }),
                "a {cut}-byte account must not decode"
            );
        }
    }

    #[test]
    fn rejects_an_unknown_status() {
        let raw = encode(1, 2, 7, [0u8; 32], DISC);
        assert_eq!(decode_escrow(&raw, &DISC), Err(DecodeError::UnknownStatus(7)));
    }

    #[test]
    fn a_zero_amount_is_never_reported_as_funded() {
        // Belt and braces: the program refuses to create one, but if an account
        // ever showed up this way, verify must not call it funded.
        let raw = encode(0, 1_900_000_000, 0, [0u8; 32], DISC);
        let e = decode_escrow(&raw, &DISC).expect("decodes");
        assert_eq!(e.status, Status::Funded);
        assert!(!e.is_funded());
    }

    #[test]
    fn the_test_encoder_agrees_with_the_declared_length() {
        // Guards the tests themselves: if `encode` and `ACCOUNT_LEN` drift, every
        // other test here would still pass while decoding a layout nothing writes.
        assert_eq!(encode(1, 2, 0, [0u8; 32], DISC).len(), ACCOUNT_LEN);
    }

    #[test]
    fn a_different_bounty_id_is_read_back_as_different() {
        // The whole point of the field: two escrows from one sponsor must be
        // distinguishable, which is what the old one-escrow-per-sponsor PDA
        // could not express.
        let mut raw = encode(1_000, 1_900_000_000, 0, [0u8; 32], DISC);
        raw[40..72].copy_from_slice(&[0xEE; 32]);
        let e = decode_escrow(&raw, &DISC).expect("decodes");
        assert_eq!(e.bounty_id, [0xEE; 32]);
        assert_ne!(e.bounty_id, BOUNTY);
    }

    #[test]
    fn extra_trailing_bytes_do_not_shift_the_fields() {
        let mut raw = encode(4_242, 1_900_000_000, 0, [0u8; 32], DISC);
        raw.extend_from_slice(&[0xAB; 16]);
        let e = decode_escrow(&raw, &DISC).expect("decodes");
        assert_eq!(e.amount, 4_242);
        assert_eq!(e.bump, 254);
    }
}
