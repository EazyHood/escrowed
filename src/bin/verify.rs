//! `escrowed verify <account>` — is the money actually there?
//!
//! Reads the account straight from a Solana RPC endpoint and decodes it. There
//! is no backend and no API key: the point of the whole project is that a hunter
//! can answer this without trusting anyone, so the tool must not introduce a
//! party to trust either.
//!
//! Usage:
//!     escrowed-verify <ACCOUNT_PUBKEY> [--rpc URL] [--discriminator HEX16]
//!
//! Exit codes are meant for scripts as much as people:
//!     0  funded — safe to start work
//!     1  present but not funded (awarded, refunded, or zero)
//!     2  no such account — the bounty is not escrowed at all
//!     3  usage or network error

use std::process::ExitCode;

use escrowed_core::decode::{decode_escrow, DecodeError, ACCOUNT_LEN, DISCRIMINATOR_LEN};
use escrowed_core::Status;

const DEFAULT_RPC: &str = "https://api.devnet.solana.com";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        eprintln!(
            "escrowed verify — check on-chain whether a bounty is really funded\n\
             \n\
             usage: escrowed-verify <ACCOUNT> [--rpc URL] [--discriminator HEX16]\n\
             \n\
             exit: 0 funded | 1 settled or empty | 2 no account | 3 error"
        );
        return ExitCode::from(3);
    }

    let account = &args[0];
    let rpc = flag(&args, "--rpc").unwrap_or_else(|| DEFAULT_RPC.to_string());
    let discriminator = match flag(&args, "--discriminator") {
        Some(hex) => match parse_discriminator(&hex) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("error: {e}");
                return ExitCode::from(3);
            }
        },
        // Anchor's tag is sha256("account:EscrowAccount")[..8]. Pinning it is the
        // caller's job once the program is deployed; until then require it
        // explicitly rather than guess and risk decoding a foreign account.
        None => {
            eprintln!(
                "error: --discriminator is required until the program is deployed.\n\
                 It is the first 8 bytes of sha256(\"account:EscrowAccount\"), as 16 hex chars.\n\
                 Requiring it is deliberate: guessing would let this tool report a\n\
                 different program's account as a funded bounty."
            );
            return ExitCode::from(3);
        }
    };

    let data = match fetch_account_data(&rpc, account) {
        Ok(Some(d)) => d,
        Ok(None) => {
            println!("NOT ESCROWED  {account}");
            println!("  no such account on {rpc}");
            println!("  nothing is locked — treat this bounty as unfunded");
            return ExitCode::from(2);
        }
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(3);
        }
    };

    match decode_escrow(&data, &discriminator) {
        Ok(e) => {
            let label = match e.status {
                Status::Funded if e.amount > 0 => "FUNDED",
                Status::Funded => "EMPTY",
                Status::Awarded => "AWARDED",
                Status::Refunded => "REFUNDED",
            };
            println!("{label}  {account}");
            println!("  amount    {} lamports", e.amount);
            println!("  deadline  {} (unix)", e.deadline);
            if let Some(w) = e.winner {
                println!("  winner    {}", bs58ish(&w));
            }
            if e.is_funded() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
        }
        // Both of these mean the same thing to a hunter: whatever is at this
        // address, it is not a funded bounty. Reporting them as tool errors
        // (exit 3) would be wrong — nothing failed, the answer is just "no".
        // Running it against real devnet accounts is what surfaced this: the
        // clock sysvar came back as `error: TooShort { got: 40 }`, which reads
        // like the tool broke rather than like a clear negative answer.
        Err(DecodeError::WrongDiscriminator) => {
            println!("NOT AN ESCROW  {account}");
            println!("  the account exists but carries a different program's tag");
            ExitCode::from(1)
        }
        Err(DecodeError::TooShort { got }) => {
            println!("NOT AN ESCROW  {account}");
            println!("  the account holds {got} bytes; an escrow is {ACCOUNT_LEN}");
            ExitCode::from(1)
        }
        Err(DecodeError::UnknownStatus(b)) => {
            // This one *is* suspicious: right size, right tag, impossible state.
            eprintln!("error: account has escrow shape but an unknown status byte ({b})");
            eprintln!("  do not treat this as funded — report it");
            ExitCode::from(3)
        }
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn parse_discriminator(hex: &str) -> Result<[u8; DISCRIMINATOR_LEN], String> {
    let clean: String = hex.trim().trim_start_matches("0x").to_lowercase();
    if clean.len() != DISCRIMINATOR_LEN * 2 {
        return Err(format!(
            "discriminator must be {} hex chars, got {}",
            DISCRIMINATOR_LEN * 2,
            clean.len()
        ));
    }
    let mut out = [0u8; DISCRIMINATOR_LEN];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16)
            .map_err(|_| format!("not hex: {}", &clean[i * 2..i * 2 + 2]))?;
    }
    Ok(out)
}

/// `getAccountInfo` over plain JSON-RPC. Deliberately hand-rolled rather than
/// pulled from the Solana SDK: this binary should build and run anywhere cargo
/// does, including on a machine with no Solana toolchain installed.
fn fetch_account_data(rpc: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["{account}",{{"encoding":"base64"}}]}}"#
    );

    let response = ureq::post(rpc)
        .set("Content-Type", "application/json")
        .send_string(&body)
        .map_err(|e| format!("rpc request failed: {e}"))?
        .into_string()
        .map_err(|e| format!("could not read rpc response: {e}"))?;

    if let Some(msg) = between(&response, r#""error":{"code":"#, "}") {
        return Err(format!("rpc returned an error: {msg}"));
    }
    // A missing account is `"value":null` — not an error, and the answer the
    // hunter most needs to see clearly.
    if response.contains(r#""value":null"#) {
        return Ok(None);
    }

    let b64 = between(&response, r#""data":[""#, r#"""#)
        .ok_or_else(|| "rpc response had no account data".to_string())?;
    base64_decode(&b64).map(Some)
}

fn between(haystack: &str, start: &str, end: &str) -> Option<String> {
    let i = haystack.find(start)? + start.len();
    let rest = &haystack[i..];
    let j = rest.find(end)?;
    Some(rest[..j].to_string())
}

/// Minimal base64 decode. Small enough to keep the dependency list at one crate.
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits = 0u8;
    for c in s.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' {
            continue;
        }
        let v = TABLE
            .iter()
            .position(|&t| t == c)
            .ok_or_else(|| format!("invalid base64 char: {}", c as char))? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

/// Pubkeys are printed as hex here rather than base58: this binary has no
/// base58 dependency, and a wrong-looking address is worse than an honest hex one.
fn bs58ish(bytes: &[u8; 32]) -> String {
    let mut s = String::with_capacity(66);
    s.push_str("hex:");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_discriminator_with_or_without_0x() {
        let want = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04];
        assert_eq!(parse_discriminator("deadbeef01020304").unwrap(), want);
        assert_eq!(parse_discriminator("0xDEADBEEF01020304").unwrap(), want);
    }

    #[test]
    fn rejects_a_discriminator_of_the_wrong_length() {
        assert!(parse_discriminator("dead").is_err());
        assert!(parse_discriminator("deadbeef010203040506").is_err());
    }

    #[test]
    fn base64_round_trips_known_vectors() {
        assert_eq!(base64_decode("").unwrap(), Vec::<u8>::new());
        assert_eq!(base64_decode("QQ==").unwrap(), b"A");
        assert_eq!(base64_decode("QUJD").unwrap(), b"ABC");
        assert_eq!(base64_decode("aGVsbG8gd29ybGQ=").unwrap(), b"hello world");
    }

    #[test]
    fn base64_rejects_junk() {
        assert!(base64_decode("not base64!!").is_err());
    }

    #[test]
    fn between_extracts_the_first_span_only() {
        assert_eq!(between("aXbXcXd", "a", "X"), None.or(Some(String::new())));
        assert_eq!(between(r#"{"data":["QUJD","base64"]}"#, r#""data":[""#, r#"""#), Some("QUJD".into()));
        assert_eq!(between("no markers here", r#""data":[""#, r#"""#), None);
    }
}
