//! Managed Cloud Pro provider (`POST /api/v1/guide`), Supabase GoTrue REST auth, and Stripe checkout.

use crate::brain::http_client::shared_http_client;
use crate::brain::json_repair::parse_and_repair_step_plan;
use crate::brain::provider::{BrainError, BrainErrorCode, BrainProvider, BrainRequest};
use crate::brain::secrets::SecretStore;
use crate::types::{BrainKind, StepPlan};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub email: Option<String>,
    pub tier: String,
    pub status: String,
    pub usage: u64,
    pub limit: u64,
}

impl AuthStatus {
    pub fn logged_out() -> Self {
        Self {
            logged_in: false,
            email: None,
            tier: "free".to_string(),
            status: "inactive".to_string(),
            usage: 0,
            limit: 1500,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckoutResponse {
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct CloudEndpoints {
    pub cloud_url: String,
    pub supabase_url: String,
    pub supabase_anon_key: String,
}

impl CloudEndpoints {
    pub fn from_env(cloud_url_override: Option<&str>) -> Self {
        let cloud_url = cloud_url_override
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string())
            .or_else(|| {
                std::env::var("GUIDELENS_CLOUD_URL")
                    .ok()
                    .filter(|v| !v.trim().is_empty())
            })
            .unwrap_or_else(|| "http://127.0.0.1:8000".to_string());

        let supabase_url = std::env::var("GUIDELENS_SUPABASE_URL")
            .ok()
            .or_else(|| std::env::var("SUPABASE_URL").ok())
            .map(|v| v.trim().trim_end_matches('/').to_string())
            .unwrap_or_default();

        let supabase_anon_key = std::env::var("GUIDELENS_SUPABASE_ANON_KEY")
            .ok()
            .or_else(|| std::env::var("SUPABASE_ANON_KEY").ok())
            .map(|v| v.trim().to_string())
            .unwrap_or_default();

        Self {
            cloud_url: cloud_url.trim_end_matches('/').to_string(),
            supabase_url,
            supabase_anon_key,
        }
    }
}

#[derive(Debug, Deserialize)]
struct GoTrueTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    user: Option<GoTrueUser>,
}

#[derive(Debug, Deserialize)]
struct GoTrueUser {
    #[serde(default)]
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CloudMePayload {
    #[serde(default)]
    email: Option<String>,
    #[serde(default = "default_free")]
    tier: String,
    #[serde(default = "default_inactive")]
    status: String,
    #[serde(default)]
    usage: u64,
    #[serde(default = "default_limit")]
    limit: u64,
}

fn default_free() -> String {
    "free".to_string()
}

fn default_inactive() -> String {
    "inactive".to_string()
}

fn default_limit() -> u64 {
    1500
}

/// Signs in via Supabase GoTrue password grant and stores the refresh + access tokens in Windows Credential Manager.
pub async fn auth_login(
    email: &str,
    password: &str,
    secrets: &SecretStore,
    endpoints: &CloudEndpoints,
) -> Result<AuthStatus, String> {
    let trimmed_email = email.trim();
    if trimmed_email.is_empty() || password.is_empty() {
        return Err("Email and password are required".to_string());
    }
    if endpoints.supabase_url.is_empty() || endpoints.supabase_anon_key.is_empty() {
        return Err(
            "Supabase URL / anon key not configured (set GUIDELENS_SUPABASE_URL and GUIDELENS_SUPABASE_ANON_KEY)."
                .to_string(),
        );
    }

    let client = shared_http_client();
    let url = format!(
        "{}/auth/v1/token?grant_type=password",
        endpoints.supabase_url
    );

    let resp = client
        .post(&url)
        .timeout(Duration::from_secs(15))
        .header("apikey", &endpoints.supabase_anon_key)
        .json(&json!({
            "email": trimmed_email,
            "password": password
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to reach Supabase Auth: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let msg = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| {
                v.get("error_description")
                    .or_else(|| v.get("msg"))
                    .or_else(|| v.get("error"))
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| format!("Authentication failed (HTTP {})", status.as_u16()));
        return Err(msg);
    }

    let token_res: GoTrueTokenResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Invalid Supabase Auth response: {}", e))?;

    let resolved_email = token_res
        .user
        .and_then(|u| u.email)
        .unwrap_or_else(|| trimmed_email.to_string());

    secrets.save_auth_tokens(
        &token_res.access_token,
        &token_res.refresh_token,
        Some(&resolved_email),
    )?;

    match fetch_me(client, &endpoints.cloud_url, &token_res.access_token).await {
        Ok(me) => Ok(AuthStatus {
            logged_in: true,
            email: me.email.or(Some(resolved_email)),
            tier: me.tier,
            status: me.status,
            usage: me.usage,
            limit: me.limit,
        }),
        Err(_) => Ok(AuthStatus {
            logged_in: true,
            email: Some(resolved_email),
            tier: "free".to_string(),
            status: "inactive".to_string(),
            usage: 0,
            limit: 1500,
        }),
    }
}

/// Refreshes the Supabase session using the stored refresh token from Credential Manager.
pub async fn refresh_session(
    secrets: &SecretStore,
    endpoints: &CloudEndpoints,
) -> Result<String, String> {
    if endpoints.supabase_url.is_empty() || endpoints.supabase_anon_key.is_empty() {
        return Err("Supabase Auth is not configured".to_string());
    }
    let refresh_token = secrets
        .get_refresh_token()?
        .ok_or_else(|| "No refresh token stored".to_string())?;

    let client = shared_http_client();
    let url = format!(
        "{}/auth/v1/token?grant_type=refresh_token",
        endpoints.supabase_url
    );
    let resp = client
        .post(&url)
        .timeout(Duration::from_secs(15))
        .header("apikey", &endpoints.supabase_anon_key)
        .json(&json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .map_err(|e| format!("Failed to refresh Supabase session: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Session refresh rejected (HTTP {})",
            resp.status().as_u16()
        ));
    }

    let token_res: GoTrueTokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Invalid refresh response: {}", e))?;

    let email = token_res.user.and_then(|u| u.email);
    secrets.save_auth_tokens(
        &token_res.access_token,
        &token_res.refresh_token,
        email.as_deref(),
    )?;

    Ok(token_res.access_token)
}

pub async fn auth_logout(secrets: &SecretStore, endpoints: &CloudEndpoints) -> Result<(), String> {
    if let Ok(Some(access)) = secrets.get_access_token() {
        if !endpoints.supabase_url.is_empty() && !endpoints.supabase_anon_key.is_empty() {
            let client = shared_http_client();
            let url = format!("{}/auth/v1/logout", endpoints.supabase_url);
            let _ = client
                .post(&url)
                .timeout(Duration::from_secs(5))
                .header("apikey", &endpoints.supabase_anon_key)
                .bearer_auth(access)
                .send()
                .await;
        }
    }
    secrets.clear_auth_tokens()
}

pub async fn auth_status(
    secrets: &SecretStore,
    endpoints: &CloudEndpoints,
) -> Result<AuthStatus, String> {
    let stored_access = secrets.get_access_token()?;
    let stored_refresh = secrets.get_refresh_token()?;
    let stored_email = secrets.get_user_email()?;

    if stored_access.is_none() && stored_refresh.is_none() {
        return Ok(AuthStatus::logged_out());
    }

    let client = shared_http_client();
    let mut token = match stored_access {
        Some(t) => t,
        None => match refresh_session(secrets, endpoints).await {
            Ok(t) => t,
            Err(_) => {
                let _ = secrets.clear_auth_tokens();
                return Ok(AuthStatus::logged_out());
            }
        },
    };

    match fetch_me(client, &endpoints.cloud_url, &token).await {
        Ok(me) => Ok(AuthStatus {
            logged_in: true,
            email: me.email.or(stored_email),
            tier: me.tier,
            status: me.status,
            usage: me.usage,
            limit: me.limit,
        }),
        Err(MeError::Unauthorized) => {
            if let Ok(fresh) = refresh_session(secrets, endpoints).await {
                token = fresh;
                if let Ok(me) = fetch_me(client, &endpoints.cloud_url, &token).await {
                    return Ok(AuthStatus {
                        logged_in: true,
                        email: me.email.or(stored_email),
                        tier: me.tier,
                        status: me.status,
                        usage: me.usage,
                        limit: me.limit,
                    });
                }
            }
            let _ = secrets.clear_auth_tokens();
            Ok(AuthStatus::logged_out())
        }
        Err(MeError::Unreachable) => Ok(AuthStatus {
            logged_in: true,
            email: stored_email,
            tier: "free".to_string(),
            status: "offline".to_string(),
            usage: 0,
            limit: 1500,
        }),
    }
}

pub async fn billing_checkout(
    plan: &str,
    secrets: &SecretStore,
    endpoints: &CloudEndpoints,
) -> Result<CheckoutResponse, String> {
    let token = match secrets.get_access_token()? {
        Some(t) => t,
        None => refresh_session(secrets, endpoints)
            .await
            .map_err(|_| "Sign in to your GuideLens account before upgrading to Pro.".to_string())?,
    };

    let normalized_plan = match plan.trim().to_ascii_lowercase().as_str() {
        "annual" | "pro_annual" | "yearly" => "annual",
        _ => "monthly",
    };

    let client = shared_http_client();
    let url = format!("{}/api/v1/billing/checkout", endpoints.cloud_url);
    let resp = client
        .post(&url)
        .timeout(Duration::from_secs(15))
        .bearer_auth(&token)
        .json(&json!({ "plan": normalized_plan }))
        .send()
        .await
        .map_err(|e| format!("Failed to reach GuideLens Cloud checkout: {}", e))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Checkout creation failed (HTTP {}): {}",
            status.as_u16(),
            body
        ));
    }

    let parsed: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Invalid checkout response JSON: {}", e))?;
    let checkout_url = parsed
        .get("url")
        .or_else(|| parsed.get("checkout_url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Checkout response missing url".to_string())?;

    Ok(CheckoutResponse { url: checkout_url })
}

enum MeError {
    Unauthorized,
    Unreachable,
}

async fn fetch_me(
    client: &Client,
    cloud_url: &str,
    access_token: &str,
) -> Result<CloudMePayload, MeError> {
    let url = format!("{}/api/v1/me", cloud_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .timeout(Duration::from_secs(8))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| MeError::Unreachable)?;

    if resp.status().as_u16() == 401 {
        return Err(MeError::Unauthorized);
    }
    if !resp.status().is_success() {
        return Err(MeError::Unreachable);
    }

    resp.json::<CloudMePayload>()
        .await
        .map_err(|_| MeError::Unreachable)
}

#[derive(Clone)]
pub struct GroqProProvider {
    pub endpoints: CloudEndpoints,
    pub secrets: SecretStore,
    pub access_token_override: Option<String>,
    client: Client,
}

impl GroqProProvider {
    pub fn new(endpoints: CloudEndpoints, secrets: SecretStore) -> Self {
        Self {
            endpoints,
            secrets,
            access_token_override: None,
            client: shared_http_client().clone(),
        }
    }

    pub fn with_token(mut self, token: impl Into<String>) -> Self {
        self.access_token_override = Some(token.into());
        self
    }

    async fn resolve_token(&self) -> Result<String, BrainError> {
        if let Some(ref tok) = self.access_token_override {
            if !tok.trim().is_empty() {
                return Ok(tok.clone());
            }
        }
        if let Ok(Some(tok)) = self.secrets.get_access_token() {
            return Ok(tok);
        }
        if let Ok(fresh) = refresh_session(&self.secrets, &self.endpoints).await {
            return Ok(fresh);
        }
        Err(BrainError::new(
            BrainErrorCode::Unauthenticated,
            BrainKind::GroqPro,
            "Sign in to your GuideLens Pro account to use Groq Cloud mode.",
        ))
    }

    async fn send_guide_request(
        &self,
        token: &str,
        req: &BrainRequest,
    ) -> Result<reqwest::Response, BrainError> {
        let url = format!("{}/api/v1/guide", self.endpoints.cloud_url);
        let active_app_title = if req.window_title.trim().is_empty() {
            req.active_app.clone()
        } else {
            format!("{} — {}", req.active_app, req.window_title)
        };

        let history: Vec<Value> = req
            .conversation_history
            .iter()
            .map(|h| json!({ "role": "user", "content": h }))
            .collect();

        let body = json!({
            "image_base64": req.image_base64,
            "query": req.query,
            "active_app_title": active_app_title,
            "screen_resolution": [req.screen_resolution.0, req.screen_resolution.1],
            "conversation_history": history
        });

        self.client
            .post(&url)
            .timeout(Duration::from_secs(18))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    BrainError::new(
                        BrainErrorCode::Timeout,
                        BrainKind::GroqPro,
                        "Groq Pro timed out. Switch to Local VLM or Agent CLI?",
                    )
                } else {
                    BrainError::new(
                        BrainErrorCode::Unavailable,
                        BrainKind::GroqPro,
                        format!(
                            "Unable to reach GuideLens Cloud at {}",
                            self.endpoints.cloud_url
                        ),
                    )
                }
            })
    }
}

#[async_trait]
impl BrainProvider for GroqProProvider {
    fn kind(&self) -> BrainKind {
        BrainKind::GroqPro
    }

    async fn generate_plan(&self, req: &BrainRequest) -> Result<StepPlan, BrainError> {
        let token = self.resolve_token().await?;
        let mut resp = self.send_guide_request(&token, req).await?;

        // Retry once after refreshing token if server returned 401
        if resp.status().as_u16() == 401 && self.access_token_override.is_none() {
            if let Ok(fresh_token) = refresh_session(&self.secrets, &self.endpoints).await {
                resp = self.send_guide_request(&fresh_token, req).await?;
            }
        }

        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();

        match status {
            200..=299 => parse_and_repair_step_plan(&body).map_err(|e| {
                BrainError::new(
                    BrainErrorCode::InvalidResponse,
                    BrainKind::GroqPro,
                    format!("Invalid StepPlan from Groq Pro: {}", e),
                )
            }),
            401 => Err(BrainError::new(
                BrainErrorCode::Unauthenticated,
                BrainKind::GroqPro,
                "Session expired. Please sign in again in Settings -> Account.",
            )),
            402 => Err(BrainError::new(
                BrainErrorCode::NotPro,
                BrainKind::GroqPro,
                "Active GuideLens Pro subscription required for Groq Cloud mode.",
            )),
            429 => {
                let parsed = serde_json::from_str::<Value>(&body).ok();
                let err_kind = parsed
                    .as_ref()
                    .and_then(|v| v.get("error").and_then(|e| e.as_str()))
                    .unwrap_or("");
                let retry_after = parsed
                    .as_ref()
                    .and_then(|v| v.get("retry_after").and_then(|r| r.as_u64()));
                let detail = parsed
                    .as_ref()
                    .and_then(|v| {
                        v.get("message")
                            .or_else(|| v.get("detail"))
                            .and_then(|m| m.as_str())
                    })
                    .unwrap_or("Groq Pro rate limit or monthly quota reached.");

                let code = if err_kind.contains("quota") {
                    BrainErrorCode::Quota
                } else {
                    BrainErrorCode::RateLimited
                };
                Err(BrainError::new(code, BrainKind::GroqPro, detail).with_retry_after(retry_after))
            }
            504 => Err(BrainError::new(
                BrainErrorCode::Timeout,
                BrainKind::GroqPro,
                "Groq Pro timed out. Switch to Local VLM or Agent CLI?",
            )),
            _ => Err(BrainError::new(
                BrainErrorCode::Unavailable,
                BrainKind::GroqPro,
                format!("GuideLens Cloud returned HTTP {}: {}", status, body),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn sample_req() -> BrainRequest {
        BrainRequest {
            query: "Remove background".to_string(),
            image_base64: "aGVsbG8=".to_string(),
            image_path: "C:\\temp\\cap.jpg".to_string(),
            active_app: "Photoshop.exe".to_string(),
            window_title: "Adobe Photoshop".to_string(),
            screen_resolution: (1920, 1080),
            system_prompt: "StepPlan".to_string(),
            user_prompt: "Remove background".to_string(),
            conversation_history: vec![],
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn groq_pro_parses_plan_and_maps_402_429_504() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/guide"))
            .and(header("authorization", "Bearer pro-jwt"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "mode": "guide",
                "total_steps": 1,
                "steps": [{
                    "step_number": 1,
                    "instruction_line": "Click Select Subject in the options bar.",
                    "target_name": "Select Subject",
                    "control_type": "Button",
                    "bbox": [410, 48, 96, 26],
                    "confidence": 0.95
                }]
            })))
            .mount(&server)
            .await;

        let secrets = SecretStore::new_memory();
        let endpoints = CloudEndpoints {
            cloud_url: server.uri(),
            supabase_url: String::new(),
            supabase_anon_key: String::new(),
        };
        let provider = GroqProProvider::new(endpoints.clone(), secrets.clone()).with_token("pro-jwt");
        let plan = provider.generate_plan(&sample_req()).await.unwrap();
        assert_eq!(plan.steps[0].target_name.as_deref(), Some("Select Subject"));

        // 402 Not Pro
        let s402 = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/guide"))
            .respond_with(ResponseTemplate::new(402).set_body_json(json!({
                "error": "pro_subscription_required"
            })))
            .mount(&s402)
            .await;
        let p402 = GroqProProvider::new(
            CloudEndpoints {
                cloud_url: s402.uri(),
                ..endpoints.clone()
            },
            secrets.clone(),
        )
        .with_token("free-jwt");
        assert_eq!(
            p402.generate_plan(&sample_req()).await.unwrap_err().code,
            BrainErrorCode::NotPro
        );

        // 429 Quota
        let s429 = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/guide"))
            .respond_with(ResponseTemplate::new(429).set_body_json(json!({
                "error": "monthly_quota_exceeded",
                "message": "1500/1500 reached",
                "retry_after": 3600
            })))
            .mount(&s429)
            .await;
        let p429 = GroqProProvider::new(
            CloudEndpoints {
                cloud_url: s429.uri(),
                ..endpoints.clone()
            },
            secrets.clone(),
        )
        .with_token("pro-jwt");
        let err_429 = p429.generate_plan(&sample_req()).await.unwrap_err();
        assert_eq!(err_429.code, BrainErrorCode::Quota);
        assert_eq!(err_429.retry_after, Some(3600));

        // 504 Timeout
        let s504 = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/guide"))
            .respond_with(ResponseTemplate::new(504).set_body_json(json!({
                "error": "groq_timeout"
            })))
            .mount(&s504)
            .await;
        let p504 = GroqProProvider::new(
            CloudEndpoints {
                cloud_url: s504.uri(),
                ..endpoints
            },
            secrets,
        )
        .with_token("pro-jwt");
        assert_eq!(
            p504.generate_plan(&sample_req()).await.unwrap_err().code,
            BrainErrorCode::Timeout
        );
    }

    #[tokio::test]
    async fn auth_login_status_and_checkout_work_with_gotrue_mock() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/auth/v1/token"))
            .and(query_param("grant_type", "password"))
            .and(header("apikey", "anon-test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "jwt-123",
                "refresh_token": "ref-456",
                "user": { "email": "pro@example.com" }
            })))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/v1/me"))
            .and(header("authorization", "Bearer jwt-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "u1",
                "email": "pro@example.com",
                "tier": "pro_monthly",
                "status": "active",
                "usage": 12,
                "limit": 1500,
                "billing_month": "2026-11"
            })))
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/api/v1/billing/checkout"))
            .and(header("authorization", "Bearer jwt-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "url": "https://checkout.stripe.com/c/pay/cs_test_123",
                "session_id": "cs_test_123"
            })))
            .mount(&server)
            .await;

        let secrets = SecretStore::new_memory();
        let endpoints = CloudEndpoints {
            cloud_url: server.uri(),
            supabase_url: server.uri(),
            supabase_anon_key: "anon-test-key".to_string(),
        };

        let status = auth_login("pro@example.com", "pw", &secrets, &endpoints)
            .await
            .expect("login succeeds");
        assert!(status.logged_in);
        assert_eq!(status.tier, "pro_monthly");
        assert_eq!(status.usage, 12);

        let checkout = billing_checkout("monthly", &secrets, &endpoints)
            .await
            .expect("checkout url");
        assert!(checkout.url.contains("stripe.com"));

        auth_logout(&secrets, &endpoints)
            .await
            .expect("logout succeeds");
        let after = auth_status(&secrets, &endpoints)
            .await
            .expect("status after logout");
        assert!(!after.logged_in);
    }
}
