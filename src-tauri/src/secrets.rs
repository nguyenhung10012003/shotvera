//! The Anthropic API key lives in the OS credential store (Keychain, Credential Manager, Secret Service),
//! never in the settings file.

const SERVICE: &str = "app.shotvera.desktop";
const ACCOUNT: &str = "anthropic-api-key";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_api_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub async fn set_api_key(key: Option<String>) -> Result<(), String> {
    let entry = entry()?;
    match key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        Some(key) => entry.set_password(key).map_err(|e| e.to_string()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        },
    }
}
