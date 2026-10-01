//! Account bytes alone never prove that a prize is locked.
use crate::{
    decode::{decode_escrow, DecodedEscrow, ACCOUNT_LEN},
    Status,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_pubkey::Pubkey;
use std::str::FromStr;
pub const PROGRAM_ID: &str = "EetC1jU5Zd686oKr7PuWG23Bfa6kjRuok2gCqxNZ5XPE";
/// Hash exact, trimmed UTF-8 text. Do not silently equate listing URLs.
pub fn listing_hash(input: &str) -> Result<[u8; 32], String> {
    let text = input.trim();
    if text.encode_utf16().count() > 2048
        || text.bytes().any(|b| b <= 32 || b == 127 || b == b'\\')
        || !(text.to_ascii_lowercase().starts_with("https://")
            || text.to_ascii_lowercase().starts_with("http://"))
    {
        return Err(
            "Use a complete URL up to 2048 characters without spaces, controls or backslashes"
                .into(),
        );
    }
    let url = url::Url::parse(text).map_err(|_| "Use a complete HTTP(S) listing URL")?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Use an HTTP(S) URL without credentials or a fragment".into());
    }
    Ok(Sha256::digest(text.as_bytes()).into())
}
pub fn discriminator() -> [u8; 8] {
    Sha256::digest(b"account:EscrowAccount")[..8]
        .try_into()
        .unwrap()
}
#[derive(Debug)]
pub struct Verification {
    pub escrow: DecodedEscrow,
    pub lamports: u64,
    pub rent: u64,
}
pub fn verify_account(
    account: &str,
    value: &Value,
    expected_sponsor: &str,
    listing: &str,
    rent: u64,
) -> Result<Verification, String> {
    let program = Pubkey::from_str(PROGRAM_ID).unwrap();
    let address = Pubkey::from_str(account).map_err(|_| "Invalid escrow address")?;
    let sponsor = Pubkey::from_str(expected_sponsor).map_err(|_| "Invalid sponsor address")?;
    if value["owner"].as_str() != Some(PROGRAM_ID) {
        return Err("Account owner does not match the Escrowed program".into());
    }
    if value["executable"].as_bool() != Some(false) {
        return Err("An executable or incomplete RPC record is not an escrow".into());
    }
    let tuple = value["data"].as_array().ok_or("Missing account data")?;
    if tuple.get(1).and_then(Value::as_str) != Some("base64") {
        return Err("Expected base64 data".into());
    }
    let raw = STANDARD
        .decode(
            tuple
                .first()
                .and_then(Value::as_str)
                .ok_or("Missing base64 bytes")?,
        )
        .map_err(|_| "Invalid base64 data")?;
    if raw.len() != ACCOUNT_LEN {
        return Err("Unsupported account layout length".into());
    }
    let escrow =
        decode_escrow(&raw, &discriminator()).map_err(|e| format!("Invalid escrow data: {e:?}"))?;
    let id = listing_hash(listing)?;
    if escrow.sponsor != sponsor.to_bytes() {
        return Err("Sponsor does not match this escrow".into());
    }
    if escrow.bounty_id != id {
        return Err("Listing URL does not match this escrow".into());
    }
    let (pda, bump) = Pubkey::find_program_address(&[b"escrow", sponsor.as_ref(), &id], &program);
    if pda != address || bump != escrow.bump {
        return Err("Escrow address or bump is not the expected PDA".into());
    }
    let lamports = value["lamports"]
        .as_u64()
        .ok_or("Missing or invalid account balance")?;
    if escrow.amount == 0 {
        return Err("Zero prize amount is not a valid bounty".into());
    }
    if escrow.deadline <= 0 || escrow.deadline > 8_640_000_000_000 {
        return Err("Invalid escrow deadline".into());
    }
    if lamports < rent {
        return Err("Balance does not cover account rent".into());
    }
    if escrow.status == Status::Funded {
        if escrow.winner.is_some() {
            return Err("Funded escrow unexpectedly has a winner".into());
        }
        let required = escrow
            .amount
            .checked_add(rent)
            .ok_or("Balance requirement overflow")?;
        if lamports < required {
            return Err("Balance does not cover the prize plus account rent".into());
        }
    }
    if escrow.status == Status::Awarded && escrow.winner.is_none() {
        return Err("Awarded escrow has no winner".into());
    }
    if escrow.status == Status::Awarded
        && matches!(escrow.winner, Some(w) if w == sponsor.to_bytes() || w == address.to_bytes())
    {
        return Err("Awarded escrow has an invalid winner".into());
    }
    if escrow.status == Status::Refunded && escrow.winner.is_some() {
        return Err("Refunded escrow has a winner".into());
    }
    Ok(Verification {
        escrow,
        lamports,
        rent,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const LISTING: &str = "https://example.org/bounty/42";
    fn fixture() -> (String, String, Value) {
        let sponsor = Pubkey::new_from_array([7; 32]);
        let id = listing_hash(LISTING).unwrap();
        let (address, bump) = Pubkey::find_program_address(
            &[b"escrow", sponsor.as_ref(), &id],
            &Pubkey::from_str(PROGRAM_ID).unwrap(),
        );
        let mut bytes = Vec::new();
        bytes.extend(discriminator());
        bytes.extend(sponsor.to_bytes());
        bytes.extend(id);
        bytes.extend(1_000_000u64.to_le_bytes());
        bytes.extend(2_000_000_000i64.to_le_bytes());
        bytes.push(0);
        bytes.extend([0; 32]);
        bytes.push(bump);
        (
            address.to_string(),
            sponsor.to_string(),
            json!({"owner": PROGRAM_ID, "executable": false,"lamports": 2_000_000,"data": [STANDARD.encode(bytes), "base64"]}),
        )
    }
    #[test]
    fn checks_owner_even_when_bytes_are_identical() {
        let (a, s, mut v) = fixture();
        v["owner"] = json!("11111111111111111111111111111111");
        assert!(verify_account(&a, &v, &s, LISTING, 1_000_000)
            .unwrap_err()
            .contains("owner"));
    }
    #[test]
    fn checks_balance_not_just_recorded_prize() {
        let (a, s, mut v) = fixture();
        v["lamports"] = json!(1_999_999);
        assert!(verify_account(&a, &v, &s, LISTING, 1_000_000)
            .unwrap_err()
            .contains("Balance"));
    }
    #[test]
    fn binds_listing_and_sponsor_and_pda() {
        let (a, s, v) = fixture();
        assert!(verify_account(&a, &v, &s, "https://example.org/bounty/other", 1_000_000).is_err());
        assert!(verify_account(&a, &v, &PROGRAM_ID, LISTING, 1_000_000).is_err());
        assert!(verify_account(PROGRAM_ID, &v, &s, LISTING, 1_000_000).is_err());
        assert!(verify_account(&a, &v, &s, LISTING, 1_000_000).is_ok());
    }
    #[test]
    fn refuses_ambiguous_or_secret_bearing_urls() {
        assert!(listing_hash("https://user:password@example.org/").is_err());
        assert!(listing_hash("https://example.org/#different").is_err());
        assert!(listing_hash("javascript:alert(1)").is_err());
        assert_eq!(
            listing_hash(&format!(" {LISTING} ")).unwrap(),
            listing_hash(LISTING).unwrap()
        );
    }
    #[test]
    fn refuses_incomplete_rpc_metadata_and_executable_accounts() {
        let (a, s, v) = fixture();
        for (field, value) in [
            ("executable", json!(true)),
            ("executable", json!(null)),
            ("lamports", json!(null)),
            ("lamports", json!(-1)),
        ] {
            let mut bad = v.clone();
            bad[field] = value;
            assert!(
                verify_account(&a, &bad, &s, LISTING, 1_000_000).is_err(),
                "{field}"
            );
        }
    }
    #[test]
    fn rejects_a_settled_record_with_a_self_recipient_or_missing_rent() {
        let (a, s, mut v) = fixture();
        let mut raw = STANDARD.decode(v["data"][0].as_str().unwrap()).unwrap();
        raw[88] = 1;
        raw[89..121].copy_from_slice(&Pubkey::from_str(&s).unwrap().to_bytes());
        v["data"][0] = json!(STANDARD.encode(&raw));
        assert!(verify_account(&a, &v, &s, LISTING, 1_000_000)
            .unwrap_err()
            .contains("winner"));
        raw[89..121].copy_from_slice(&[9; 32]);
        v["data"][0] = json!(STANDARD.encode(raw));
        v["lamports"] = json!(999_999);
        assert!(verify_account(&a, &v, &s, LISTING, 1_000_000)
            .unwrap_err()
            .contains("rent"));
    }
}
