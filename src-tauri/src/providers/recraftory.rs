use sabi::provider::{
    CreateOutcome, GenerateRequest, ImageProvider, PollOutcome, ProviderInfo,
    OUT_OF_CREDITS_ERROR,
};
use serde::Deserialize;

/// RecraftoryProvider delegates generation to the Recraftory cloud backend
/// (Cloudflare Workers). `req.api_key` is the Recraftory API key (Bearer
/// token). `req.provider_api_key` (when present) is the downstream provider
/// key (e.g. Gemini) forwarded to Recraftory.
///
/// TODO: not production-ready — deliberately left out of
/// `crate::provider::all_providers()` until the cloud backend is ready to
/// ship. Kept compiling so the integration isn't lost.
#[allow(dead_code)]
pub struct RecraftoryProvider;

#[async_trait::async_trait]
impl ImageProvider for RecraftoryProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            id: "recraftory".to_string(),
            label: "Recraftory".to_string(),
            key_hint: "cld_...".to_string(),
            key_url: "https://cloud.example.com".to_string(),
        }
    }

    async fn create(&self, req: GenerateRequest) -> Result<CreateOutcome, String> {
        let endpoint = recraftory_endpoint()?;

        let body = serde_json::json!({
            "prompt": req.prompt,
            "sourceDataUri": req.image_data_uri,
            "provider": "google",
            "providerApiKey": req.provider_api_key.unwrap_or_default(),
        });

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

        let resp = client
            .post(format!("{}/api/jobs", endpoint))
            .header("Authorization", format!("Bearer {}", req.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Failed to reach Recraftory backend: {}", e))?;

        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read Recraftory response: {}", e))?;

        if status.as_u16() == 402 {
            return Err(OUT_OF_CREDITS_ERROR.to_string());
        }
        if !status.is_success() {
            return Err(format!("Recraftory API error ({}): {}", status, body_text));
        }

        let parsed: serde_json::Value = serde_json::from_str(&body_text)
            .map_err(|e| format!("Recraftory API parse error: {}", e))?;

        let job_id = parsed
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("Recraftory response missing id: {}", body_text))?;

        Ok(CreateOutcome::Pending {
            poll_url: format!("{}/api/jobs/{}", endpoint, job_id),
        })
    }

    async fn poll(&self, poll_url: &str, api_key: &str) -> Result<PollOutcome, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

        let resp = client
            .get(poll_url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
            .map_err(|e| format!("Failed to poll Recraftory backend: {}", e))?;

        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read Recraftory response: {}", e))?;

        if !status.is_success() {
            return Err(format!("Recraftory poll error ({}): {}", status, body_text));
        }

        let parsed: serde_json::Value = serde_json::from_str(&body_text)
            .map_err(|e| format!("Recraftory poll parse error: {}", e))?;

        let job_status = parsed
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        match job_status {
            "queued" | "pending" => Ok(PollOutcome::Pending { logs: None }),
            "succeeded" => {
                let output_path = parsed
                    .get("outputPath")
                    .and_then(|v| v.as_str())
                    .ok_or("Recraftory response missing outputPath")?;

                // Download the image from Recraftory
                let img_resp = client
                    .get(format!("{}/api/images/{}", recraftory_endpoint()?, output_path))
                    .send()
                    .await
                    .map_err(|e| format!("Failed to download image: {}", e))?;

                let img_bytes = img_resp
                    .bytes()
                    .await
                    .map_err(|e| format!("Failed to read image: {}", e))?
                    .to_vec();

                Ok(PollOutcome::Done {
                    image_bytes: img_bytes,
                    ext: "jpg".to_string(),
                    logs: None,
                })
            }
            "failed" => {
                let error = parsed
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Recraftory job failed");
                Ok(PollOutcome::Failed {
                    error: error.to_string(),
                    logs: None,
                })
            }
            _ => Ok(PollOutcome::Failed {
                error: format!("Unknown job status: {}", job_status),
                logs: None,
            }),
        }
    }
}

use std::sync::Mutex;

/// A `Mutex` (not `OnceLock`) because the endpoint is user-editable at
/// runtime from the settings UI, not just set once at startup.
static RECRAFTORY_ENDPOINT: Mutex<Option<String>> = Mutex::new(None);

pub fn set_recraftory_endpoint(endpoint: String) {
    *RECRAFTORY_ENDPOINT.lock().unwrap() = Some(endpoint);
}

fn recraftory_endpoint() -> Result<String, String> {
    RECRAFTORY_ENDPOINT
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Recraftory endpoint not configured".to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreditBalanceResponse {
    credit_balance: i64,
}

/// Queries the Recraftory backend for the current key's remaining credit balance.
pub async fn get_credit_balance(api_key: &str) -> Result<i64, String> {
    let endpoint = recraftory_endpoint()?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = client
        .get(format!("{}/api/credit-keys/me", endpoint))
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("Failed to reach Recraftory backend: {}", e))?;

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read Recraftory response: {}", e))?;

    if !status.is_success() {
        return Err(format!("Recraftory API error ({}): {}", status, body_text));
    }

    let parsed: CreditBalanceResponse = serde_json::from_str(&body_text)
        .map_err(|e| format!("Recraftory API parse error: {}", e))?;

    Ok(parsed.credit_balance)
}
