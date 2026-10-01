//! Escrowed — the Anchor shell.
//!
//! Deliberately thin. Every rule that decides whether funds move lives in
//! `escrowed-core`, which has no Solana types in it and is tested with plain
//! `cargo test`. This file resolves accounts, asks the core what should happen,
//! and moves lamports accordingly.
//!
//! The split is the point: escrow bugs hide in the transitions you are *not*
//! supposed to be able to make — awarding twice, refunding early, awarding after
//! a refund. Those are exhaustively tested in the core, without a validator.

use anchor_lang::prelude::*;
use escrowed_core::{Actor, Escrow as CoreEscrow, EscrowError as CoreError, Status as CoreStatus};

declare_id!("EetC1jU5Zd686oKr7PuWG23Bfa6kjRuok2gCqxNZ5XPE");

#[program]
pub mod escrowed {
    use super::*;

    /// Lock `amount` lamports until `deadline`. The bounty is only publishable
    /// once this succeeds — that is the whole guarantee.
    pub fn create_bounty(
        ctx: Context<CreateBounty>,
        bounty_id: [u8; 32],
        amount: u64,
        deadline: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let sponsor = ctx.accounts.sponsor.key();

        // Validate through the core so the rules live in exactly one place.
        let core =
            CoreEscrow::create(sponsor.to_bytes(), amount, deadline, now).map_err(map_err)?;

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.sponsor.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.sponsor = sponsor;
        escrow.bounty_id = bounty_id;
        escrow.amount = core.amount;
        escrow.deadline = core.deadline;
        escrow.status = Status::Funded;
        escrow.winner = Pubkey::default();
        escrow.bump = ctx.bumps.escrow;

        emit!(BountyCreated {
            escrow: escrow.key(),
            sponsor,
            bounty_id,
            amount,
            deadline
        });
        Ok(())
    }

    /// Release the prize to the winner. Sponsor only, once, and not to
    /// themselves. Allowed after the deadline on purpose: a late award is still
    /// the sponsor honouring the bounty.
    pub fn award(ctx: Context<Award>) -> Result<()> {
        let winner = ctx.accounts.winner.key();
        let mut core = ctx.accounts.escrow.to_core();

        let payout = core
            .award(Actor::Sponsor, winner.to_bytes())
            .map_err(map_err)?;

        // The escrow PDA holds the lamports, so move them directly rather than
        // via a CPI the PDA would have to sign for.
        let escrow_ai = ctx.accounts.escrow.to_account_info();
        let winner_ai = ctx.accounts.winner.to_account_info();
        transfer_prize(
            &escrow_ai,
            &winner_ai,
            payout.amount,
            Rent::get()?.minimum_balance(escrow_ai.data_len()),
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = Status::Awarded;
        escrow.winner = winner;

        emit!(BountyAwarded {
            escrow: escrow.key(),
            winner,
            amount: payout.amount
        });
        Ok(())
    }

    /// Return the funds to the sponsor once the deadline has passed unawarded.
    ///
    /// Callable by anyone: the money must not be holdable hostage by a sponsor
    /// who stops responding, and a refund can only ever return it to the
    /// sponsor, so a third-party caller gains nothing by triggering it.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut core = ctx.accounts.escrow.to_core();

        let payout = core.refund(now).map_err(map_err)?;

        let escrow_ai = ctx.accounts.escrow.to_account_info();
        let sponsor_ai = ctx.accounts.sponsor.to_account_info();
        transfer_prize(
            &escrow_ai,
            &sponsor_ai,
            payout.amount,
            Rent::get()?.minimum_balance(escrow_ai.data_len()),
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.status = Status::Refunded;

        emit!(BountyRefunded {
            escrow: escrow.key(),
            sponsor: escrow.sponsor,
            amount: payout.amount
        });
        Ok(())
    }
}

/// Move the prize only after both resulting balances have been validated.
/// An award to the escrow itself used to mark it paid without moving funds:
/// the debit and credit aliased the same account. Reject that destination and
/// executable accounts, preserve the account's rent reserve, and fail before
/// either balance changes when an arithmetic check fails.
fn transfer_prize(
    escrow: &AccountInfo,
    recipient: &AccountInfo,
    amount: u64,
    rent_reserve: u64,
) -> Result<()> {
    require_keys_neq!(*escrow.key, *recipient.key, EscrowedError::InvalidRecipient);
    require!(!recipient.executable, EscrowedError::InvalidRecipient);
    let source_after = escrow
        .lamports()
        .checked_sub(amount)
        .filter(|remaining| *remaining >= rent_reserve)
        .ok_or(EscrowedError::InsufficientEscrowBalance)?;
    let recipient_after = recipient
        .lamports()
        .checked_add(amount)
        .ok_or(EscrowedError::RecipientBalanceOverflow)?;
    let mut source_balance = escrow.try_borrow_mut_lamports()?;
    let mut recipient_balance = recipient.try_borrow_mut_lamports()?;
    **source_balance = source_after;
    **recipient_balance = recipient_after;
    Ok(())
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
#[instruction(bounty_id: [u8; 32])]
pub struct CreateBounty<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,

    /// One escrow per (sponsor, bounty), not one per sponsor. The earlier seeds
    /// were `[b"escrow", sponsor]`, which gave every sponsor exactly one escrow
    /// account for life: their second bounty could never be created, because
    /// `init` would hit an address that already exists. Binding the bounty id
    /// also makes the escrow address derivable from the listing it belongs to,
    /// which is what lets a hunter check a link without being handed an address.
    #[account(
        init,
        payer = sponsor,
        space = EscrowAccount::SPACE,
        seeds = [b"escrow", sponsor.key().as_ref(), bounty_id.as_ref()],
        bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Award<'info> {
    // `has_one = sponsor` plus Signer is what makes Actor::Sponsor true below.
    // Without both, the core would be told "sponsor" for any caller.
    pub sponsor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", sponsor.key().as_ref(), escrow.bounty_id.as_ref()],
        bump = escrow.bump,
        has_one = sponsor
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// CHECK: only receives lamports; its key is what the core binds as winner.
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    /// Anyone may trigger it; they pay the transaction, not receive the funds.
    pub caller: Signer<'info>,

    /// CHECK: constrained by `has_one` below, and it is the only possible
    /// destination — a refund cannot pay anyone but the sponsor.
    #[account(mut)]
    pub sponsor: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"escrow", sponsor.key().as_ref(), escrow.bounty_id.as_ref()],
        bump = escrow.bump,
        has_one = sponsor
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

// ---------------------------------------------------------------- state

#[account]
pub struct EscrowAccount {
    pub sponsor: Pubkey,
    /// Identifies which bounty this escrow backs — in practice the SHA-256 of
    /// the listing URL. Stored as well as used as a seed, so a verifier reading
    /// the account can confirm it belongs to the listing being checked.
    pub bounty_id: [u8; 32],
    pub amount: u64,
    pub deadline: i64,
    pub status: Status,
    pub winner: Pubkey,
    pub bump: u8,
}

impl EscrowAccount {
    // discriminator + sponsor + bounty_id + amount + deadline + status + winner + bump
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 8 + 1 + 32 + 1;

    /// Hand the on-chain state to the core, which owns every decision.
    fn to_core(&self) -> CoreEscrow {
        CoreEscrow {
            sponsor: self.sponsor.to_bytes(),
            amount: self.amount,
            deadline: self.deadline,
            status: match self.status {
                Status::Funded => CoreStatus::Funded,
                Status::Awarded => CoreStatus::Awarded,
                Status::Refunded => CoreStatus::Refunded,
            },
            winner: if self.winner == Pubkey::default() {
                None
            } else {
                Some(self.winner.to_bytes())
            },
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Funded,
    Awarded,
    Refunded,
}

// ---------------------------------------------------------------- events

#[event]
pub struct BountyCreated {
    pub escrow: Pubkey,
    pub sponsor: Pubkey,
    pub bounty_id: [u8; 32],
    pub amount: u64,
    pub deadline: i64,
}

#[event]
pub struct BountyAwarded {
    pub escrow: Pubkey,
    pub winner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BountyRefunded {
    pub escrow: Pubkey,
    pub sponsor: Pubkey,
    pub amount: u64,
}

// ---------------------------------------------------------------- errors

#[error_code]
pub enum EscrowedError {
    #[msg("Only the sponsor can award this bounty")]
    NotSponsor,
    #[msg("This bounty has already been awarded or refunded")]
    AlreadySettled,
    #[msg("The deadline has not passed yet")]
    DeadlineNotReached,
    #[msg("A bounty must escrow more than zero")]
    ZeroAmount,
    #[msg("The deadline is already in the past")]
    DeadlineInPast,
    #[msg("The sponsor cannot award the bounty to themselves")]
    SelfAward,
    #[msg("The prize recipient must not be the escrow itself or an executable account")]
    InvalidRecipient,
    #[msg("The escrow cannot pay this prize while preserving its rent reserve")]
    InsufficientEscrowBalance,
    #[msg("The recipient balance would overflow")]
    RecipientBalanceOverflow,
}

fn map_err(e: CoreError) -> Error {
    match e {
        CoreError::NotSponsor => EscrowedError::NotSponsor.into(),
        CoreError::AlreadySettled => EscrowedError::AlreadySettled.into(),
        CoreError::DeadlineNotReached => EscrowedError::DeadlineNotReached.into(),
        CoreError::ZeroAmount => EscrowedError::ZeroAmount.into(),
        CoreError::DeadlineInPast => EscrowedError::DeadlineInPast.into(),
        CoreError::SelfAward => EscrowedError::SelfAward.into(),
    }
}

// ---------------------------------------------------------------- layout guard

#[cfg(test)]
mod tests {
    use super::*;

    /// The account layout is written here and read in `escrowed_core::decode`.
    /// Two spellings of one thing drift silently: the day a field is added here
    /// and not there, `verify` keeps answering — confidently, from the wrong
    /// offsets — that a bounty is funded. This test is the only thing that makes
    /// that drift loud.
    #[test]
    fn the_decoder_and_the_account_agree_on_the_layout() {
        assert_eq!(
            EscrowAccount::SPACE,
            escrowed_core::decode::ACCOUNT_LEN,
            "EscrowAccount::SPACE and escrowed_core::decode::ACCOUNT_LEN disagree"
        );
    }

    #[test]
    fn anchor_serialization_matches_every_decoder_field() {
        use anchor_lang::Discriminator;
        let sponsor = Pubkey::new_from_array([7; 32]);
        let winner = Pubkey::new_from_array([9; 32]);
        for (status, expected) in [
            (Status::Funded, CoreStatus::Funded),
            (Status::Awarded, CoreStatus::Awarded),
            (Status::Refunded, CoreStatus::Refunded),
        ] {
            let account = EscrowAccount {
                sponsor,
                bounty_id: [3; 32],
                amount: 123_456_789,
                deadline: 1_900_000_001,
                status,
                winner: if expected == CoreStatus::Awarded {
                    winner
                } else {
                    Pubkey::default()
                },
                bump: 251,
            };
            let mut bytes = Vec::new();
            account
                .try_serialize(&mut bytes)
                .expect("Anchor account serialization");
            assert_eq!(bytes.len(), EscrowAccount::SPACE);
            let discriminator: [u8; 8] = EscrowAccount::DISCRIMINATOR
                .try_into()
                .expect("eight-byte discriminator");
            let decoded = escrowed_core::decode::decode_escrow(&bytes, &discriminator)
                .expect("decode Anchor bytes");
            assert_eq!(decoded.sponsor, sponsor.to_bytes());
            assert_eq!(decoded.bounty_id, [3; 32]);
            assert_eq!(decoded.amount, 123_456_789);
            assert_eq!(decoded.deadline, 1_900_000_001);
            assert_eq!(decoded.status, expected);
            assert_eq!(
                decoded.winner,
                if expected == CoreStatus::Awarded {
                    Some(winner.to_bytes())
                } else {
                    None
                }
            );
            assert_eq!(decoded.bump, 251);
        }
    }

    /// A sponsor must be able to fund more than one bounty. The seeds are what
    /// decide that, so pin them: two different bounty ids under the same sponsor
    /// have to land on two different addresses.
    #[test]
    fn one_sponsor_can_hold_two_different_escrows() {
        let sponsor = Pubkey::new_unique();
        let (a, _) =
            Pubkey::find_program_address(&[b"escrow", sponsor.as_ref(), &[1u8; 32]], &crate::ID);
        let (b, _) =
            Pubkey::find_program_address(&[b"escrow", sponsor.as_ref(), &[2u8; 32]], &crate::ID);
        assert_ne!(
            a, b,
            "two bounties from one sponsor collided on one address"
        );
    }

    /// Host-level balance checks; these do not replace validator integration.
    fn check_transfer(
        initial_source: u64,
        initial_recipient: u64,
        amount: u64,
        rent: u64,
        executable: bool,
    ) -> (Result<()>, u64, u64) {
        let source_key = Pubkey::new_unique();
        let recipient_key = Pubkey::new_unique();
        let owner = crate::ID;
        let mut source_balance = initial_source;
        let mut recipient_balance = initial_recipient;
        let mut source_data = [0u8; EscrowAccount::SPACE];
        let mut recipient_data = [];
        let source = AccountInfo::new(
            &source_key,
            false,
            true,
            &mut source_balance,
            &mut source_data,
            &owner,
            false,
            0,
        );
        let recipient = AccountInfo::new(
            &recipient_key,
            false,
            true,
            &mut recipient_balance,
            &mut recipient_data,
            &owner,
            executable,
            0,
        );
        let result = transfer_prize(&source, &recipient, amount, rent);
        (result, source.lamports(), recipient.lamports())
    }

    #[test]
    fn prize_moves_once_and_preserves_rent() {
        let (result, source, recipient) = check_transfer(1_500, 25, 500, 1_000, false);
        assert!(result.is_ok());
        assert_eq!((source, recipient), (1_000, 525));
    }

    #[test]
    fn underfunded_or_rent_consuming_payment_changes_neither_balance() {
        for source in [400, 1_499] {
            let (result, after, recipient) = check_transfer(source, 25, 500, 1_000, false);
            assert!(result.is_err());
            assert_eq!((after, recipient), (source, 25));
        }
    }

    #[test]
    fn overflowing_recipient_changes_neither_balance() {
        let (result, source, recipient) = check_transfer(1_500, u64::MAX, 500, 1_000, false);
        assert!(result.is_err());
        assert_eq!((source, recipient), (1_500, u64::MAX));
    }

    #[test]
    fn executable_recipient_is_rejected_without_moving_funds() {
        let (result, source, recipient) = check_transfer(1_500, 25, 500, 1_000, true);
        assert!(result.is_err());
        assert_eq!((source, recipient), (1_500, 25));
    }

    #[test]
    fn awarding_to_the_escrow_itself_is_rejected_without_moving_funds() {
        let key = Pubkey::new_unique();
        let owner = crate::ID;
        let mut balance = 1_500;
        let mut data = [0u8; EscrowAccount::SPACE];
        let escrow = AccountInfo::new(&key, false, true, &mut balance, &mut data, &owner, false, 0);
        assert!(transfer_prize(&escrow, &escrow.clone(), 500, 1_000).is_err());
        assert_eq!(escrow.lamports(), 1_500);
    }
}
