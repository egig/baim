use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::provider::{
    CreateOutcome, GenerateRequest, ImageProvider, PollOutcome, ProviderInfo,
};

/// Image-capable Gemini model ("Nano Banana 2"), driven through the Interactions
/// API. It returns the edited image inline in the same interaction response, so
/// the provider is synchronous and never polls.
const MODEL: &str = "gemini-3.1-flash-image";

/// Interactions API endpoint. Unlike the older `generateContent` API, the model
/// is passed in the request body rather than the URL path.
const ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1/interactions";

/// How long a single interaction call may take before we give up on it. Image
/// generation can be slow, so this is generous.
const REQUEST_TIMEOUT_SECS: u64 = 120;

/// Total attempts (initial + retries) for transient server errors. Gemini
/// returns `503 UNAVAILABLE` ("Deadline expired…") when the model is overloaded;
/// retrying with backoff usually succeeds.
const MAX_ATTEMPTS: u32 = 3;

pub struct GoogleProvider;

// ---- request shape ----
//
// The Interactions API's `input` is an array of *steps*, not raw content items.
// User-provided prompt + image go inside a single `user_input` step whose
// `content[]` holds the typed content items (`{"type":"text",…}` /
// `{"type":"image","data":…,"mime_type":…}`). Passing content items directly at
// the top level is rejected with a 400 ("'image' is not supported for 'type'").

#[derive(Serialize)]
struct Request {
    model: String,
    input: Vec<InputStep>,
}

#[derive(Serialize)]
struct InputStep {
    #[serde(rename = "type")]
    kind: &'static str,
    content: Vec<ReqContent>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ReqContent {
    Text { text: String },
    Image { data: String, mime_type: String },
}

// ---- response shape ----
//
// A completed interaction carries its output in `steps[].content[]`; a generated
// image is a content item with `type:"image"`, holding base64 `data` and a
// `mime_type`. (`output_image` in the docs is an SDK convenience, absent here.)

#[derive(Deserialize)]
struct Response {
    steps: Option<Vec<Step>>,
    status: Option<String>,
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct ApiError {
    message: String,
}

#[derive(Deserialize)]
struct Step {
    content: Option<Vec<RespContent>>,
}

/// A single content item. Fields are optional because the discriminant `type`
/// selects which are present (text vs image vs audio…).
#[derive(Deserialize)]
struct RespContent {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
    data: Option<String>,
    mime_type: Option<String>,
}

/// Split a `data:<mime>;base64,<data>` URI into its mime type and base64 payload.
fn parse_data_uri(uri: &str) -> Result<(String, String), String> {
    let rest = uri
        .strip_prefix("data:")
        .ok_or("Source image is not a data URI")?;
    let (meta, data) = rest
        .split_once(',')
        .ok_or("Malformed source image data URI")?;
    let mime = meta.split(';').next().filter(|m| !m.is_empty()).unwrap_or("image/png");
    Ok((mime.to_string(), data.to_string()))
}

/// File extension for a returned image mime type.
fn ext_for_mime(mime: &str) -> String {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
    .to_string()
}

/// Outcome of one HTTP attempt. `Retryable` failures (transient server overload,
/// network timeouts) are worth another attempt; `Fatal` ones (auth, bad request,
/// safety refusals, decode errors) are not.
enum AttemptError {
    Retryable(String),
    Fatal(String),
}

/// Whether an HTTP status is a transient server-side error worth retrying.
/// Gemini uses `503` for "Deadline expired…"; `500`/`502`/`504` are the usual
/// gateway/overload family.
fn is_retryable_status(status: u16) -> bool {
    matches!(status, 500 | 502 | 503 | 504)
}

/// Perform a single interaction call and extract the generated image,
/// classifying any failure as retryable or fatal.
async fn try_generate(
    client: &reqwest::Client,
    api_key: &str,
    payload: &Request,
) -> Result<CreateOutcome, AttemptError> {
    let resp = client
        .post(ENDPOINT)
        .header("x-goog-api-key", api_key)
        .header("Content-Type", "application/json")
        .json(payload)
        .send()
        .await
        .map_err(|e| {
            // A timeout or connection drop is transient — retry it.
            if e.is_timeout() || e.is_connect() {
                AttemptError::Retryable(format!("Failed to reach Gemini: {}", e))
            } else {
                AttemptError::Fatal(format!("Failed to reach Gemini: {}", e))
            }
        })?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AttemptError::Fatal(format!("Failed to read Gemini response: {}", e)))?;

    let parsed: Response = serde_json::from_str(&body).map_err(|e| {
        AttemptError::Fatal(format!(
            "Failed to parse Gemini response: {} — body: {}",
            e, body
        ))
    })?;

    if !status.is_success() {
        let msg = parsed
            .error
            .map(|e| e.message)
            .unwrap_or_else(|| body.clone());
        let full = match status.as_u16() {
            429 => format!("Rate limited by Gemini (429): {}", msg),
            code => format!("Gemini API error ({}): {}", code, msg),
        };
        // 429 (rate limit) and 5xx are transient; other 4xx are not.
        return Err(if status.as_u16() == 429 || is_retryable_status(status.as_u16()) {
            AttemptError::Retryable(full)
        } else {
            AttemptError::Fatal(full)
        });
    }

    let steps = parsed
        .steps
        .ok_or_else(|| AttemptError::Fatal("Gemini returned no steps".to_string()))?;

    // Flatten every step's content and take the first image item.
    let contents: Vec<&RespContent> = steps
        .iter()
        .filter_map(|s| s.content.as_ref())
        .flatten()
        .collect();

    let image = contents
        .iter()
        .find(|c| c.kind.as_deref() == Some("image") && c.data.is_some())
        .ok_or_else(|| {
            // Surface any text the model returned instead (often a safety
            // refusal), so the failure is legible. Not retryable.
            let text = contents
                .iter()
                .find_map(|c| c.text.clone())
                .unwrap_or_else(|| {
                    format!(
                        "no image in response (status: {})",
                        parsed.status.as_deref().unwrap_or("unknown")
                    )
                });
            AttemptError::Fatal(format!("Gemini did not return an image: {}", text))
        })?;

    let data = image
        .data
        .as_ref()
        .ok_or_else(|| AttemptError::Fatal("Gemini image had no data".to_string()))?;

    let image_bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| AttemptError::Fatal(format!("Failed to decode Gemini image: {}", e)))?;

    let ext = ext_for_mime(image.mime_type.as_deref().unwrap_or("image/png"));

    Ok(CreateOutcome::Done { image_bytes, ext })
}

#[async_trait::async_trait]
impl ImageProvider for GoogleProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            id: "google".to_string(),
            label: "Google".to_string(),
            key_hint: "AIza...".to_string(),
            key_url: "https://aistudio.google.com/apikey".to_string(),
        }
    }

    async fn create(&self, req: GenerateRequest) -> Result<CreateOutcome, String> {
        let (mime_type, data) = parse_data_uri(&req.image_data_uri)?;

        let payload = Request {
            model: MODEL.to_string(),
            input: vec![InputStep {
                kind: "user_input",
                content: vec![
                    ReqContent::Text {
                        text: req.prompt.clone(),
                    },
                    ReqContent::Image { data, mime_type },
                ],
            }],
        };

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

        // Retry transient overload errors (Gemini's 503 "Deadline expired" and
        // network timeouts) with exponential backoff; return other failures
        // (auth, bad request, safety refusals) immediately.
        let mut last_err = String::new();
        for attempt in 1..=MAX_ATTEMPTS {
            match try_generate(&client, &req.api_key, &payload).await {
                Ok(outcome) => return Ok(outcome),
                Err(AttemptError::Fatal(msg)) => return Err(msg),
                Err(AttemptError::Retryable(msg)) => {
                    last_err = msg;
                    if attempt < MAX_ATTEMPTS {
                        // 2s, then 4s.
                        let backoff = std::time::Duration::from_secs(2u64 << (attempt - 1));
                        tokio::time::sleep(backoff).await;
                    }
                }
            }
        }

        Err(format!(
            "Gemini unavailable after {} attempts: {}",
            MAX_ATTEMPTS, last_err
        ))
    }

    async fn poll(&self, _poll_url: &str, _api_key: &str) -> Result<PollOutcome, String> {
        // Gemini finishes synchronously in `create`, so a pending Google
        // generation should never exist to be polled.
        Err("Google generations complete synchronously and cannot be polled".to_string())
    }
}
