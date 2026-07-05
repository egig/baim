use base64::Engine;
use serde::Serialize;

use crate::provider::{
    CreateOutcome, GenerateRequest, ImageProvider, PollOutcome, ProviderInfo,
};

/// Image-capable Gemini model ("Nano Banana"), driven through the **Batch API**
/// (`:batchGenerateContent`). `create` submits a single-request inline batch job
/// and returns immediately with the job's operation URL; `poll` GETs that
/// operation until the job reaches `JOB_STATE_SUCCEEDED` and reads the generated
/// image out of the inline response. Batch trades latency (target turnaround up
/// to 24h, usually much faster) for 50% cost and higher rate limits.
const MODEL: &str = "gemini-3.1-flash-image";

/// Base of the generateContent (v1beta) API. `create` POSTs to
/// `{API_BASE}/models/{MODEL}:batchGenerateContent`; `poll` GETs
/// `{API_BASE}/{operation_name}` (the name returned by create, e.g.
/// `batches/123456`).
const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

/// How long a single HTTP call may take. Both create (job submission) and poll
/// (one status check) are quick; the generous ceiling just covers slow networks.
const REQUEST_TIMEOUT_SECS: u64 = 120;

/// Total attempts (initial + retries) for transient server errors on job
/// submission. Gemini returns `503 UNAVAILABLE` when overloaded; retrying with
/// backoff usually succeeds.
const MAX_ATTEMPTS: u32 = 3;

pub struct GoogleProvider;

// ---- request shape ----
//
// A batch job wraps one or more `GenerateContentRequest`s. For a single image
// edit we submit exactly one inline request: the prompt as a text part and the
// source image as an `inline_data` part, asking for an IMAGE response modality.
// The nesting (`batch.input_config.requests.requests[]`) mirrors the REST docs.

#[derive(Serialize)]
struct CreateBatchRequest {
    batch: Batch,
}

#[derive(Serialize)]
struct Batch {
    display_name: String,
    input_config: InputConfig,
}

#[derive(Serialize)]
struct InputConfig {
    requests: RequestList,
}

#[derive(Serialize)]
struct RequestList {
    requests: Vec<InlineRequest>,
}

#[derive(Serialize)]
struct InlineRequest {
    request: GenerateContentRequest,
    metadata: RequestMetadata,
}

#[derive(Serialize)]
struct RequestMetadata {
    key: String,
}

#[derive(Serialize)]
struct GenerateContentRequest {
    contents: Vec<Content>,
    generation_config: GenerationConfig,
}

#[derive(Serialize)]
struct Content {
    parts: Vec<Part>,
}

/// A content part is either text or inline binary data. The two shapes are
/// distinguished by which key is present (no `type` discriminator), so an
/// untagged enum serializes to `{"text":…}` or `{"inline_data":{…}}`.
#[derive(Serialize)]
#[serde(untagged)]
enum Part {
    Text { text: String },
    Inline { inline_data: InlineData },
}

#[derive(Serialize)]
struct InlineData {
    mime_type: String,
    data: String,
}

#[derive(Serialize)]
struct GenerationConfig {
    response_modalities: Vec<&'static str>,
}

/// Split a `data:<mime>;base64,<data>` URI into its mime type and base64 payload.
fn parse_data_uri(uri: &str) -> Result<(String, String), String> {
    let rest = uri
        .strip_prefix("data:")
        .ok_or("Source image is not a data URI")?;
    let (meta, data) = rest
        .split_once(',')
        .ok_or("Malformed source image data URI")?;
    let mime = meta
        .split(';')
        .next()
        .filter(|m| !m.is_empty())
        .unwrap_or("image/png");
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

/// Whether an HTTP status is a transient server-side error worth retrying.
fn is_retryable_status(status: u16) -> bool {
    matches!(status, 500 | 502 | 503 | 504)
}

/// Outcome of one HTTP attempt. `Retryable` failures (transient server overload,
/// network timeouts) are worth another attempt; `Fatal` ones (auth, bad request,
/// safety refusals, decode errors) are not.
enum AttemptError {
    Retryable(String),
    Fatal(String),
}

// ---- response parsing ----
//
// A batch job submitted via `:batchGenerateContent` returns a long-running
// `Operation` (polled by GET), whose contract is `done: bool` plus exactly one of
// `error` / `response` once finished. The batch `state` (`BATCH_STATE_*` per the
// REST schema, though the SDKs surface it as `JOB_STATE_*`) sits inside `metadata`
// while running and inside `response` once done, and the generated image can be
// nested at varying depths inside the inline `GenerateContentResponse`. Rather
// than bet on one rigid struct, we parse into `serde_json::Value`, drive off
// `done`, and search the tree defensively (matching state by suffix so either
// enum prefix works).

/// The batch job's lifecycle state (`*_SUCCEEDED`/`*_FAILED`/…), hunted from
/// wherever the Operation places it (`metadata.state` or `response...state`).
fn find_state(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Object(map) => {
            if let Some(s) = map.get("state").and_then(|s| s.as_str()) {
                return Some(s.to_string());
            }
            map.values().find_map(find_state)
        }
        serde_json::Value::Array(arr) => arr.iter().find_map(find_state),
        _ => None,
    }
}

/// Recursively walk the JSON looking for the first inline image, tolerating both
/// `inline_data`/`inlineData` and `mime_type`/`mimeType` spellings. Returns the
/// base64 `data` and its mime type.
fn find_inline_image(v: &serde_json::Value) -> Option<(String, String)> {
    match v {
        serde_json::Value::Object(map) => {
            // An inline-data node has a `data` string and a mime type. Accept the
            // node directly whether it is the `inline_data` wrapper or its inner
            // object.
            let inline = map
                .get("inline_data")
                .or_else(|| map.get("inlineData"))
                .unwrap_or(v);
            if let Some(data) = inline.get("data").and_then(|d| d.as_str()) {
                let mime = inline
                    .get("mime_type")
                    .or_else(|| inline.get("mimeType"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("image/png");
                if mime.starts_with("image/") {
                    return Some((data.to_string(), mime.to_string()));
                }
            }
            map.values().find_map(find_inline_image)
        }
        serde_json::Value::Array(arr) => arr.iter().find_map(find_inline_image),
        _ => None,
    }
}

/// Recursively collect any `text` string values (used to surface a model's
/// textual refusal when no image came back).
fn find_text(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Object(map) => {
            if let Some(t) = map.get("text").and_then(|t| t.as_str()) {
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
            map.values().find_map(find_text)
        }
        serde_json::Value::Array(arr) => arr.iter().find_map(find_text),
        _ => None,
    }
}

/// The first `error.message` found anywhere in the tree — covers both the
/// operation-level `Operation.error` and a per-request `InlinedResponse.error`
/// (a `Status`) when the batch itself succeeded but the single request failed.
fn find_error_message(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Object(map) => {
            if let Some(msg) = map
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
            {
                return Some(msg.to_string());
            }
            map.values().find_map(find_error_message)
        }
        serde_json::Value::Array(arr) => arr.iter().find_map(find_error_message),
        _ => None,
    }
}

/// Submit the inline batch job once and return its operation poll URL,
/// classifying any failure as retryable or fatal.
async fn try_create(
    client: &reqwest::Client,
    api_key: &str,
    payload: &CreateBatchRequest,
) -> Result<CreateOutcome, AttemptError> {
    let url = format!("{}/models/{}:batchGenerateContent", API_BASE, MODEL);

    let resp = client
        .post(&url)
        .header("x-goog-api-key", api_key)
        .header("Content-Type", "application/json")
        .json(payload)
        .send()
        .await
        .map_err(|e| {
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

    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        AttemptError::Fatal(format!(
            "Failed to parse Gemini response: {} — body: {}",
            e, body
        ))
    })?;

    if !status.is_success() {
        let msg = find_error_message(&parsed).unwrap_or(body);
        let full = match status.as_u16() {
            429 => format!("Rate limited by Gemini (429): {}", msg),
            code => format!("Gemini API error ({}): {}", code, msg),
        };
        return Err(if status.as_u16() == 429 || is_retryable_status(status.as_u16()) {
            AttemptError::Retryable(full)
        } else {
            AttemptError::Fatal(full)
        });
    }

    // The Operation's `name` (e.g. `batches/123456`) is the handle we poll.
    let name = parsed
        .get("name")
        .and_then(|n| n.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AttemptError::Fatal(format!("Batch job response had no operation name: {}", body))
        })?;

    Ok(CreateOutcome::Pending {
        poll_url: format!("{}/{}", API_BASE, name),
    })
}

/// Decode the first inline image found in a completed batch response.
fn extract_image(v: &serde_json::Value) -> Result<(Vec<u8>, String), String> {
    let (data, mime) = find_inline_image(v).ok_or_else(|| {
        let text = find_text(v).unwrap_or_else(|| "no image in batch response".to_string());
        format!("Gemini did not return an image: {}", text)
    })?;

    let image_bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Failed to decode Gemini image: {}", e))?;

    Ok((image_bytes, ext_for_mime(&mime)))
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

        let payload = CreateBatchRequest {
            batch: Batch {
                display_name: "catalog-image-generator".to_string(),
                input_config: InputConfig {
                    requests: RequestList {
                        requests: vec![InlineRequest {
                            request: GenerateContentRequest {
                                contents: vec![Content {
                                    parts: vec![
                                        Part::Text {
                                            text: req.prompt.clone(),
                                        },
                                        Part::Inline {
                                            inline_data: InlineData { mime_type, data },
                                        },
                                    ],
                                }],
                                generation_config: GenerationConfig {
                                    response_modalities: vec!["TEXT", "IMAGE"],
                                },
                            },
                            metadata: RequestMetadata {
                                key: "variant".to_string(),
                            },
                        }],
                    },
                },
            },
        };

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

        // Retry transient overload errors on submission with exponential backoff;
        // return other failures (auth, bad request) immediately.
        let mut last_err = String::new();
        for attempt in 1..=MAX_ATTEMPTS {
            match try_create(&client, &req.api_key, &payload).await {
                Ok(outcome) => return Ok(outcome),
                Err(AttemptError::Fatal(msg)) => return Err(msg),
                Err(AttemptError::Retryable(msg)) => {
                    last_err = msg;
                    if attempt < MAX_ATTEMPTS {
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

    /// Fetch the batch `Operation` once and map it to a poll outcome, driving off
    /// the `done` flag and the batch `state` (matched by suffix so `BATCH_STATE_*`
    /// and `JOB_STATE_*` both work). On success the image is pulled out of the
    /// inline response; terminal failures map to `Failed`; anything still running
    /// stays `Pending`.
    async fn poll(&self, poll_url: &str, api_key: &str) -> Result<PollOutcome, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

        let resp = client
            .get(poll_url)
            .header("x-goog-api-key", api_key)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch Gemini batch job: {}", e))?;

        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read Gemini response: {}", e))?;

        let parsed: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse Gemini response: {} — body: {}", e, body))?;

        if !status.is_success() {
            let msg = find_error_message(&parsed).unwrap_or(body);
            return Err(format!("Gemini API error ({}): {}", status, msg));
        }

        let done = parsed.get("done").and_then(|d| d.as_bool()).unwrap_or(false);
        let state = find_state(&parsed);
        let ends = |suffix: &str| state.as_deref().is_some_and(|s| s.ends_with(suffix));
        let error = find_error_message(&parsed);

        // Terminal failure: an explicit failed/cancelled/expired state, or a
        // finished operation that carries an error.
        if ends("FAILED") || ends("CANCELLED") || ends("EXPIRED") || (done && error.is_some()) {
            let msg = error
                .or_else(|| find_text(&parsed))
                .or_else(|| state.clone())
                .unwrap_or_else(|| "Gemini batch job failed".to_string());
            return Ok(PollOutcome::Failed { error: msg });
        }

        // Success: the operation is done (without an error) or the batch reports a
        // `*_SUCCEEDED` state. Pull the image out; if the single request errored
        // instead, surface that.
        if done || ends("SUCCEEDED") {
            return match extract_image(&parsed) {
                Ok((image_bytes, ext)) => Ok(PollOutcome::Done { image_bytes, ext }),
                Err(msg) => Ok(PollOutcome::Failed {
                    error: error.unwrap_or(msg),
                }),
            };
        }

        // Still pending/running.
        Ok(PollOutcome::Pending)
    }
}
