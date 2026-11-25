//! Secure credential storage backed by Windows Credential Manager (`keyring` crate),
//! accelerated by an in-memory `RwLock` cache invalidated immediately on writes/deletes.
//! Never stores API keys or tokens in SQLite, plain-text files, or logs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

pub const KEYRING_SERVICE: &str = "com.guidelens.desktop";
pub const SUPPORTED_BYO_PROVIDERS: [&str; 7] = [
    "gemini",
    "openai",
    "anthropic",
    "groq",
    "openrouter",
    "deepseek",
    "custom_openai",
];

const ACCOUNT_REFRESH_TOKEN: &str = "supabase_refresh_token";
const ACCOUNT_ACCESS_TOKEN: &str = "supabase_access_token";
const ACCOUNT_USER_EMAIL: &str = "supabase_user_email";

pub trait SecretBackend: Send + Sync {
    fn get_secret(&self, account: &str) -> Result<Option<String>, String>;
    fn set_secret(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete_secret(&self, account: &str) -> Result<(), String>;
}

/// Production Windows Credential Manager backend via `keyring`.
#[derive(Debug, Default)]
pub struct KeyringSecretBackend;

impl SecretBackend for KeyringSecretBackend {
    fn get_secret(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|e| format!("Failed to open credential entry '{}': {}", account, e))?;
        match entry.get_password() {
            Ok(secret) => {
                let trimmed = secret.trim().to_string();
                if trimmed.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(trimmed))
                }
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!(
                "Failed to read credential '{}': {}",
                account, e
            )),
        }
    }

    fn set_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|e| format!("Failed to open credential entry '{}': {}", account, e))?;
        entry
            .set_password(value)
            .map_err(|e| format!("Failed to store credential '{}': {}", account, e))
    }

    fn delete_secret(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|e| format!("Failed to open credential entry '{}': {}", account, e))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!(
                "Failed to delete credential '{}': {}",
                account, e
            )),
        }
    }
}

/// Thread-safe in-memory secret store for unit and integration tests.
#[derive(Debug, Default, Clone)]
pub struct MemorySecretBackend {
    map: Arc<Mutex<HashMap<String, String>>>,
}

impl MemorySecretBackend {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretBackend for MemorySecretBackend {
    fn get_secret(&self, account: &str) -> Result<Option<String>, String> {
        let guard = self
            .map
            .lock()
            .map_err(|_| "Secret store mutex poisoned".to_string())?;
        Ok(guard.get(account).cloned())
    }

    fn set_secret(&self, account: &str, value: &str) -> Result<(), String> {
        let mut guard = self
            .map
            .lock()
            .map_err(|_| "Secret store mutex poisoned".to_string())?;
        guard.insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn delete_secret(&self, account: &str) -> Result<(), String> {
        let mut guard = self
            .map
            .lock()
            .map_err(|_| "Secret store mutex poisoned".to_string())?;
        guard.remove(account);
        Ok(())
    }
}

#[derive(Clone)]
pub struct SecretStore {
    backend: Arc<dyn SecretBackend>,
    api_key_cache: Arc<RwLock<HashMap<String, Option<String>>>>,
    providers_list_cache: Arc<RwLock<Option<Vec<String>>>>,
}

impl Default for SecretStore {
    fn default() -> Self {
        Self::new_keyring()
    }
}

impl std::fmt::Debug for SecretStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretStore").finish_non_exhaustive()
    }
}

impl SecretStore {
    pub fn new_keyring() -> Self {
        Self::with_backend(Arc::new(KeyringSecretBackend))
    }

    pub fn new_memory() -> Self {
        Self::with_backend(Arc::new(MemorySecretBackend::new()))
    }

    pub fn with_backend(backend: Arc<dyn SecretBackend>) -> Self {
        Self {
            backend,
            api_key_cache: Arc::new(RwLock::new(HashMap::new())),
            providers_list_cache: Arc::new(RwLock::new(None)),
        }
    }

    pub fn normalize_provider(provider: &str) -> Result<&'static str, String> {
        let clean = provider.trim().to_ascii_lowercase();
        for &p in &SUPPORTED_BYO_PROVIDERS {
            if p == clean {
                return Ok(p);
            }
        }
        Err(format!(
            "Unsupported API provider '{}'. Expected one of: {}",
            provider,
            SUPPORTED_BYO_PROVIDERS.join(", ")
        ))
    }

    fn api_key_account(provider: &str) -> Result<String, String> {
        let norm = Self::normalize_provider(provider)?;
        Ok(format!("byo_api_key:{}", norm))
    }

    fn invalidate_caches(&self, norm_provider: &str) {
        if let Ok(mut cache) = self.api_key_cache.write() {
            cache.remove(norm_provider);
        }
        if let Ok(mut list_cache) = self.providers_list_cache.write() {
            *list_cache = None;
        }
    }

    pub fn set_api_key(&self, provider: &str, key: &str) -> Result<(), String> {
        let norm = Self::normalize_provider(provider)?;
        let account = format!("byo_api_key:{}", norm);
        let trimmed = key.trim();
        if trimmed.is_empty() {
            return Err("API key must not be empty".to_string());
        }
        self.backend.set_secret(&account, trimmed)?;
        if let Ok(mut cache) = self.api_key_cache.write() {
            cache.insert(norm.to_string(), Some(trimmed.to_string()));
        }
        if let Ok(mut list_cache) = self.providers_list_cache.write() {
            *list_cache = None;
        }
        Ok(())
    }

    pub fn get_api_key(&self, provider: &str) -> Result<Option<String>, String> {
        let norm = Self::normalize_provider(provider)?;
        if let Ok(cache) = self.api_key_cache.read() {
            if let Some(cached) = cache.get(norm) {
                return Ok(cached.clone());
            }
        }

        let account = format!("byo_api_key:{}", norm);
        let backend_res = self.backend.get_secret(&account);
        if let Ok(Some(ref key)) = backend_res {
            let trimmed = key.trim().to_string();
            if !trimmed.is_empty() {
                let val = Some(trimmed);
                if let Ok(mut cache) = self.api_key_cache.write() {
                    cache.insert(norm.to_string(), val.clone());
                }
                return Ok(val);
            }
        }

        let env_key = format!("{}_API_KEY", norm.to_ascii_uppercase());
        if let Ok(val) = std::env::var(&env_key) {
            let trimmed = val.trim().to_string();
            if !trimmed.is_empty() {
                let res = Some(trimmed);
                if let Ok(mut cache) = self.api_key_cache.write() {
                    cache.insert(norm.to_string(), res.clone());
                }
                return Ok(res);
            }
        }

        if backend_res.is_ok() {
            if let Ok(mut cache) = self.api_key_cache.write() {
                cache.insert(norm.to_string(), None);
            }
        }

        Ok(None)
    }

    pub fn delete_api_key(&self, provider: &str) -> Result<(), String> {
        let norm = Self::normalize_provider(provider)?;
        let account = Self::api_key_account(norm)?;
        self.backend.delete_secret(&account)?;
        self.invalidate_caches(norm);
        Ok(())
    }

    pub fn list_api_key_providers(&self) -> Result<Vec<String>, String> {
        if let Ok(list_cache) = self.providers_list_cache.read() {
            if let Some(ref cached) = *list_cache {
                return Ok(cached.clone());
            }
        }

        let mut present = Vec::new();
        for &provider in &SUPPORTED_BYO_PROVIDERS {
            if let Ok(Some(_)) = self.get_api_key(provider) {
                present.push(provider.to_string());
            }
        }
        if let Ok(mut list_cache) = self.providers_list_cache.write() {
            *list_cache = Some(present.clone());
        }
        Ok(present)
    }

    pub fn save_auth_tokens(
        &self,
        access_token: &str,
        refresh_token: &str,
        email: Option<&str>,
    ) -> Result<(), String> {
        if !access_token.trim().is_empty() {
            self.backend
                .set_secret(ACCOUNT_ACCESS_TOKEN, access_token.trim())?;
        }
        if !refresh_token.trim().is_empty() {
            self.backend
                .set_secret(ACCOUNT_REFRESH_TOKEN, refresh_token.trim())?;
        }
        if let Some(mail) = email.map(str::trim).filter(|m| !m.is_empty()) {
            self.backend.set_secret(ACCOUNT_USER_EMAIL, mail)?;
        }
        Ok(())
    }

    pub fn get_access_token(&self) -> Result<Option<String>, String> {
        self.backend.get_secret(ACCOUNT_ACCESS_TOKEN)
    }

    pub fn get_refresh_token(&self) -> Result<Option<String>, String> {
        self.backend.get_secret(ACCOUNT_REFRESH_TOKEN)
    }

    pub fn get_user_email(&self) -> Result<Option<String>, String> {
        self.backend.get_secret(ACCOUNT_USER_EMAIL)
    }

    pub fn clear_auth_tokens(&self) -> Result<(), String> {
        let _ = self.backend.delete_secret(ACCOUNT_ACCESS_TOKEN);
        let _ = self.backend.delete_secret(ACCOUNT_REFRESH_TOKEN);
        let _ = self.backend.delete_secret(ACCOUNT_USER_EMAIL);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingBackend {
        inner: MemorySecretBackend,
        reads: AtomicUsize,
    }

    impl CountingBackend {
        fn new() -> Self {
            Self {
                inner: MemorySecretBackend::new(),
                reads: AtomicUsize::new(0),
            }
        }
    }

    impl SecretBackend for CountingBackend {
        fn get_secret(&self, account: &str) -> Result<Option<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.inner.get_secret(account)
        }

        fn set_secret(&self, account: &str, value: &str) -> Result<(), String> {
            self.inner.set_secret(account, value)
        }

        fn delete_secret(&self, account: &str) -> Result<(), String> {
            self.inner.delete_secret(account)
        }
    }

    #[test]
    fn stores_lists_and_deletes_byo_keys_and_tokens() {
        let store = SecretStore::new_memory();
        assert_eq!(store.list_api_key_providers().unwrap(), Vec::<String>::new());

        store.set_api_key("Gemini", "AIza-fake-test-key").unwrap();
        store.set_api_key("openai", "sk-fake-test-key").unwrap();
        store.set_api_key("deepseek", "ds-fake-test-key").unwrap();
        store.set_api_key("custom_openai", "cust-fake-test-key").unwrap();

        let providers = store.list_api_key_providers().unwrap();
        assert_eq!(
            providers,
            vec!["gemini", "openai", "deepseek", "custom_openai"]
        );
        assert_eq!(
            store.get_api_key("gemini").unwrap().as_deref(),
            Some("AIza-fake-test-key")
        );

        store.delete_api_key("gemini").unwrap();
        assert_eq!(
            store.list_api_key_providers().unwrap(),
            vec!["openai", "deepseek", "custom_openai"]
        );
        assert!(store.set_api_key("invalid_provider", "abc").is_err());

        store
            .save_auth_tokens("jwt-access", "jwt-refresh", Some("user@example.com"))
            .unwrap();
        assert_eq!(
            store.get_access_token().unwrap().as_deref(),
            Some("jwt-access")
        );
        assert_eq!(
            store.get_refresh_token().unwrap().as_deref(),
            Some("jwt-refresh")
        );
        assert_eq!(
            store.get_user_email().unwrap().as_deref(),
            Some("user@example.com")
        );
        store.clear_auth_tokens().unwrap();
        assert_eq!(store.get_access_token().unwrap(), None);
        assert_eq!(store.get_refresh_token().unwrap(), None);
    }

    #[test]
    fn in_memory_cache_avoids_repeat_backend_reads_and_invalidates_on_write() {
        let backend = Arc::new(CountingBackend::new());
        let store = SecretStore::with_backend(backend.clone());

        assert_eq!(store.list_api_key_providers().unwrap(), Vec::<String>::new());
        let initial_reads = backend.reads.load(Ordering::SeqCst);
        assert_eq!(initial_reads, SUPPORTED_BYO_PROVIDERS.len());

        // Subsequent calls hit cache without touching backend
        for _ in 0..5 {
            assert_eq!(store.list_api_key_providers().unwrap(), Vec::<String>::new());
            assert_eq!(store.get_api_key("groq").unwrap(), None);
        }
        assert_eq!(backend.reads.load(Ordering::SeqCst), initial_reads);

        // set_api_key immediately updates cache & invalidates list cache
        store.set_api_key("groq", "gsk_cached").unwrap();
        assert_eq!(
            store.get_api_key("groq").unwrap().as_deref(),
            Some("gsk_cached")
        );
        assert_eq!(store.list_api_key_providers().unwrap(), vec!["groq"]);
        assert_eq!(backend.reads.load(Ordering::SeqCst), initial_reads);

        // delete_api_key invalidates cache immediately
        store.delete_api_key("groq").unwrap();
        assert_eq!(store.get_api_key("groq").unwrap(), None);
        assert_eq!(store.list_api_key_providers().unwrap(), Vec::<String>::new());
    }
}
