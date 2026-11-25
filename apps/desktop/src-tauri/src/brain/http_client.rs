//! Shared global HTTP connection pool (`OnceLock<reqwest::Client>`) for ultra-low-latency API calls.

use reqwest::Client;
use std::sync::OnceLock;
use std::time::Duration;

static SHARED_HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

/// Returns a process-wide pooled `reqwest::Client` with TCP_NODELAY and persistent keep-alive connections.
/// Callers should apply per-request `.timeout(...)` on the `RequestBuilder`.
pub fn shared_http_client() -> &'static Client {
    SHARED_HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent("GuideLens/2.0")
            .tcp_nodelay(true)
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_http_client_returns_singleton_instance() {
        let a = shared_http_client() as *const Client;
        let b = shared_http_client() as *const Client;
        assert_eq!(a, b);
    }
}
