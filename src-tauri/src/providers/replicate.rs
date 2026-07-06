use serde::Deserialize;

use crate::provider::{
    CreateOutcome, GenerateRequest, ImageProvider, PollOutcome, ProviderInfo,
};

/// Model output format. Kept as a constant so the request payload and the saved
/// file extension can never drift apart.
const OUTPUT_FORMAT: &str = "jpg";

/// Replicate image provider, backed by `google/nano-banana-2` in async mode.
pub struct ReplicateProvider;

#[derive(Debug, Deserialize)]
struct Prediction {
    status: String,
    output: Option<serde_json::Value>,
    error: Option<String>,
    urls: Option<PredictionUrls>,
    /// Replicate streams a growing, human-readable log blob here while the
    /// prediction runs. Surfaced to the generation detail panel.
    #[serde(default)]
    logs: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PredictionUrls {
    get: Option<String>,
}

#[async_trait::async_trait]
impl ImageProvider for ReplicateProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            id: "replicate".to_string(),
            label: "Replicate".to_string(),
            key_hint: "r8_...".to_string(),
            key_url: "https://replicate.com/account/api-tokens".to_string(),
        }
    }

    /// Create a prediction in Replicate's async mode (no `Prefer: wait` header):
    /// the request returns immediately with `status: "starting"` and a poll URL
    /// under `urls.get` that `poll` advances later.
    async fn create(&self, req: GenerateRequest) -> Result<CreateOutcome, String> {
        let client = reqwest::Client::new();

        let model = "google/nano-banana-2";
        let payload = serde_json::json!({
            "input": {
                "prompt": req.prompt,
                "resolution": "1K",
                "image_input": [req.image_data_uri],
                "aspect_ratio": "1:1",
                "output_format": OUTPUT_FORMAT,
            },
        });
        let url = format!("https://api.replicate.com/v1/models/{}/predictions", model);

        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", req.api_key))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Failed to create prediction: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_else(|_| "unknown".to_string());
            return Err(match status.as_u16() {
                402 => "API quota exceeded or payment required".to_string(),
                429 => format!(
                    "Rate limited by Replicate (429). Accounts without a payment method are \
                     capped at ~6 requests/min; add billing at replicate.com/account/billing. \
                     Response: {}",
                    body
                ),
                _ => format!("Replicate API error ({}): {}", status, body),
            });
        }

        let prediction: Prediction = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if prediction.status == "failed" || prediction.status == "canceled" {
            return Err(prediction
                .error
                .unwrap_or_else(|| prediction.status.clone()));
        }

        let poll_url = prediction
            .urls
            .and_then(|u| u.get)
            .ok_or("Replicate response had no poll URL")?;

        Ok(CreateOutcome::Pending { poll_url })
    }

    /// Poll a prediction once. On success, downloads the image bytes so the
    /// orchestrator can save them; maps `failed`/`canceled` to `Failed`, and any
    /// non-terminal status (`starting`/`processing`) back to `Pending`.
    async fn poll(&self, poll_url: &str, api_key: &str) -> Result<PollOutcome, String> {
        let client = reqwest::Client::new();
        let resp = client
            .get(poll_url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch prediction status: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_else(|_| "unknown".to_string());
            return Err(format!(
                "Failed to fetch prediction status ({}): {}",
                status, body
            ));
        }

        let prediction: Prediction = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse status response: {}", e))?;

        match prediction.status.as_str() {
            "succeeded" => {
                let output = prediction.output.ok_or("No output from model")?;
                // Replicate returns either an array of URLs or a bare string.
                let image_url = output
                    .as_array()
                    .and_then(|arr| arr.first())
                    .and_then(|v| v.as_str())
                    .or_else(|| output.as_str())
                    .ok_or("Unexpected output format")?
                    .to_string();

                let image_bytes = client
                    .get(&image_url)
                    .send()
                    .await
                    .map_err(|e| format!("Failed to download image: {}", e))?
                    .bytes()
                    .await
                    .map_err(|e| format!("Failed to read image bytes: {}", e))?
                    .to_vec();

                Ok(PollOutcome::Done {
                    image_bytes,
                    ext: OUTPUT_FORMAT.to_string(),
                    logs: prediction.logs,
                })
            }
            "failed" | "canceled" => Ok(PollOutcome::Failed {
                error: prediction
                    .error
                    .unwrap_or_else(|| prediction.status.clone()),
                logs: prediction.logs,
            }),
            _ => Ok(PollOutcome::Pending {
                logs: prediction.logs,
            }),
        }
    }
}
