//! Read-only verifier. Never signs or accepts private keys.
use escrowed_core::{
    decode::ACCOUNT_LEN,
    verification::{verify_account, PROGRAM_ID},
    Status,
};
use serde_json::{json, Value};
use std::{process::ExitCode, time::Duration};
fn rpc(url: &str, method: &str, params: Value) -> Result<Value, String> {
    let body = json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
    let text = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .build()
        .post(url)
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .map_err(|e| format!("RPC request failed: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    parse_rpc(&text)
}
fn parse_rpc(text: &str) -> Result<Value, String> {
    let response: Value = serde_json::from_str(text).map_err(|_| "RPC returned invalid JSON")?;
    if let Some(e) = response.get("error") {
        return Err(format!("RPC returned {e}"));
    }
    response
        .get("result")
        .cloned()
        .ok_or("RPC returned no result".into())
}
fn run() -> Result<u8, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 3 && args.len() != 5 {
        return Err("Usage: cargo run --bin verify -- <ESCROW_ADDRESS> <SPONSOR_ADDRESS> <EXACT_LISTING_URL> [--rpc URL]".into());
    }
    let endpoint = if args.len() == 5 {
        if args[3] != "--rpc" {
            return Err("Unknown option; use --rpc URL".into());
        }
        &args[4]
    } else {
        "https://api.devnet.solana.com"
    };
    let info = rpc(
        endpoint,
        "getAccountInfo",
        json!([args[0],{"encoding":"base64","commitment":"finalized"}]),
    )?;
    let value = info.get("value").ok_or("RPC result has no account value")?;
    if value.is_null() {
        println!("NOT FOUND on {endpoint}. No account exists at {}.", args[0]);
        return Ok(2);
    }
    let rent = rpc(
        endpoint,
        "getMinimumBalanceForRentExemption",
        json!([ACCOUNT_LEN]),
    )?
    .as_u64()
    .ok_or("RPC returned invalid rent")?;
    let v = verify_account(&args[0], value, &args[1], &args[2], rent)?;
    let label = match v.escrow.status {
        Status::Funded => "PRIZE LOCKED",
        Status::Awarded => "AWARDED",
        Status::Refunded => "REFUNDED",
    };
    println!("{label}\n  network: {endpoint}\n  finalized slot: {}\n  program: {PROGRAM_ID}\n  sponsor: {}\n  listing: {}\n  prize: {} lamports\n  account balance: {} lamports\n  account rent: {} lamports\n  refund available at: {} (Unix seconds)",info["context"]["slot"],args[1],args[2].trim(),v.escrow.amount,v.lamports,v.rent,v.escrow.deadline);
    println!("Funding is a snapshot, not a promise of selection or payment. Anyone can return an unawarded prize to its sponsor after the deadline. This prototype program is upgradeable and unaudited. Devnet SOL has no monetary value.");
    Ok(if v.escrow.status == Status::Funded {
        0
    } else {
        1
    })
}
fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("UNVERIFIED: {e}");
            ExitCode::from(3)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_valid_json_whitespace_and_null() {
        assert!(parse_rpc("{ \"result\": {\"value\": null} }").unwrap()["value"].is_null());
    }
    #[test]
    fn rejects_rpc_errors_and_missing_result() {
        assert!(parse_rpc(r#"{"error":{"code":-32000,"message":"unavailable"}}"#).is_err());
        assert!(parse_rpc("{}").is_err());
        assert!(parse_rpc("not JSON").is_err());
    }
}
