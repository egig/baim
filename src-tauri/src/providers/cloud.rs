use sabi::provider::{
    CreateOutcome, GenerateRequest, ImageProvider, PollOutcome, ProviderInfo,
};

/// CloudProvider delegates generation to the cloud backend (Cloudflare Workers).
/// `req.api_key` is the cloud API key (Bearer token). `req.provider_api_key`
/// (when present) is the downstream provider key (e.g. Gemini) forwarded to the
/// cloud.
pub struct CloudProvider;

#[async_trait::async_trait]
impl ImageProvider for CloudProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            id: "cloud".to_string(),
            label: "Cloud".to_string(),
            key_hint: "cld_...".to_string(),
            key_url: "https://cloud.example.com".to_string(),
        }
    }

    async fn create(&self, req: GenerateRequest) -> Result<CreateOutcome, String> {
        let endpoint = CLOUD_ENDPOINT
            .get()
            .ok_or_else(|| "Cloud endpoint not configured")?;

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
            .map_err(|e| format!("Failed to reach cloud backend: {}", e))?;

        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read cloud response: {}", e))?;

        if !status.is_success() {
            return Err(format!("Cloud API error ({}): {}", status, body_text));
        }

        let parsed: serde_json::Value = serde_json::from_str(&body_text)
            .map_err(|e| format!("Cloud API parse error: {}", e))?;

        let job_id = parsed
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("Cloud response missing id: {}", body_text))?;

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
            .map_err(|e| format!("Failed to poll cloud backend: {}", e))?;

        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read cloud response: {}", e))?;

        if !status.is_success() {
            return Err(format!("Cloud poll error ({}): {}", status, body_text));
        }

        let parsed: serde_json::Value = serde_json::from_str(&body_text)
            .map_err(|e| format!("Cloud poll parse error: {}", e))?;

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
                    .ok_or("Cloud response missing outputPath")?;

                // Download the image from the cloud
                let img_resp = client
                    .get(format!("{}/api/images/{}", CLOUD_ENDPOINT.get().ok_or("Cloud endpoint not configured")?, output_path))
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
                    .unwrap_or("Cloud job failed");
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

use std::sync::OnceLock;

static CLOUD_ENDPOINT: OnceLock<String> = OnceLock::new();

pub fn set_cloud_endpoint(endpoint: String) {
    let _ = CLOUD_ENDPOINT.set(endpoint);
}
