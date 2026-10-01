//! Export the IDL through Anchor's own compilation-based IdlBuilder.
//! This creates no wallet, program keypair, or network transaction.
use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let repo = PathBuf::from(
        env::args()
            .nth(1)
            .ok_or("usage: escrowed-export-idl ABSOLUTE_REPO_PATH")?,
    );
    if !repo.is_absolute() {
        return Err("repository path must be absolute".into());
    }
    // Use the caller's installed cargo. IdlBuilder 0.1.4 otherwise forwards a
    // literal +{toolchain} argument when this rustup-internal variable is set.
    env::remove_var("RUSTUP_TOOLCHAIN");
    let idl = anchor_lang_idl::build::IdlBuilder::new()
        .program_path(repo.join("programs/escrowed"))
        .cargo_args(vec!["--locked".into()])
        .build()?;
    if idl.address != "EetC1jU5Zd686oKr7PuWG23Bfa6kjRuok2gCqxNZ5XPE" {
        return Err("generated IDL does not match the pinned program id".into());
    }
    let output = repo.join("artifacts/idl/escrowed.json");
    fs::create_dir_all(output.parent().ok_or("missing output directory")?)?;
    fs::write(
        &output,
        format!("{}\n", anchor_lang_idl::serde_json::to_string_pretty(&idl)?),
    )?;
    println!("Generated IDL via Anchor IdlBuilder: {}", output.display());
    Ok(())
}
