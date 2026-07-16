use base64::Engine;
use serde::Serialize;

use crate::provider::{
    ApiMode, CreateOutcome, GenerateRequest, ImageProvider, PollOutcome, ProviderInfo,
    RATE_LIMITED_ERROR,
};

const MODEL: &str = "gemini-3.1-flash-image";
const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";
const REQUEST_TIMEOUT_SECS: u64 = 120;
const MAX_ATTEMPTS: u32 = 3;

pub struct GoogleProvider;

// ---- request shape ----

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

// ---- interactions request shape ----
// Synchronous counterpart to the batch shape above: one `input` array in, one
// Interaction resource out (no operation/poll_url). Despite both ultimately
// reaching the same underlying model, the Interactions API's `input` shape is
// NOT the Batch/generateContent `Content{parts: [...]}` shape — confirmed
// live: a `{"parts": [...]}` object with no `type` field was rejected with
// "Provide a 'role' field (for Turn[]), or a 'type' field (for Step[])",
// since `input` is a polymorphic union (Content[] / Step[] / Turn[] / string)
// disambiguated by a `type` (Content/Step) or `role` (Turn) tag. Content here
// is a flat, per-part object tagged by `type` — `{"type":"text","text":...}`
// / `{"type":"image","mime_type":...,"data":...}` — not `generateContent`'s
// nested `{parts: [{text...}, {inline_data...}]}`. Also unlike the Batch
// shape, `response_modalities` is a *top-level* request field here, not
// nested under `generation_config` (confirmed live too — see
// `build_interaction_payload`'s call site).
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum InteractionContent {
    Text { text: String },
    Image { mime_type: String, data: String },
}

#[derive(Serialize)]
struct CreateInteractionRequest {
    model: String,
    input: Vec<InteractionContent>,
    response_modalities: Vec<&'static str>,
}

// ---- helpers ----

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

fn ext_for_mime(mime: &str) -> String {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
    .to_string()
}

fn is_retryable_status(status: u16) -> bool {
    matches!(status, 500 | 502 | 503 | 504)
}

enum AttemptError {
    Retryable(String),
    Fatal(String),
}

// ---- response parsing ----

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

fn find_inline_image(v: &serde_json::Value) -> Option<(String, String)> {
    match v {
        serde_json::Value::Object(map) => {
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

/// Whether an object is itself a per-item result entry: it has an echoed
/// `metadata.key`. Entries live somewhere under the response's
/// `inlinedResponses`/`inlined_responses`, but the exact wrapper nesting
/// isn't load-bearing here — deliberately not hardcoded to one guessed path,
/// same spirit as this file's other recursive `find_*` helpers, since a
/// wrong path guess would silently fall through to matching nothing (see
/// below) rather than error loudly.
fn entry_key(v: &serde_json::Value) -> Option<&str> {
    v.get("metadata")?.get("key")?.as_str()
}

/// Recursively finds the per-item entry whose echoed `metadata.key` matches
/// `key`, searching the whole response tree rather than assuming one exact
/// wrapper path.
fn find_by_metadata_key<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    match v {
        serde_json::Value::Object(map) => {
            if entry_key(v) == Some(key) {
                return Some(v);
            }
            map.values().find_map(|val| find_by_metadata_key(val, key))
        }
        serde_json::Value::Array(arr) => arr.iter().find_map(|val| find_by_metadata_key(val, key)),
        _ => None,
    }
}

/// Collects every per-item entry (anything with a `metadata.key`) found
/// anywhere in the tree, for the single-item fallback below.
fn collect_metadata_entries<'a>(v: &'a serde_json::Value, out: &mut Vec<&'a serde_json::Value>) {
    match v {
        serde_json::Value::Object(map) => {
            if entry_key(v).is_some() {
                out.push(v);
            }
            for val in map.values() {
                collect_metadata_entries(val, out);
            }
        }
        serde_json::Value::Array(arr) => {
            for val in arr {
                collect_metadata_entries(val, out);
            }
        }
        _ => {}
    }
}

/// Picks out one item's entry from a batch response by its echoed
/// `metadata.key`. Single-item jobs (including every job created before
/// per-item keys existed, whose key is always `"variant"`) fall back to the
/// sole entry found anywhere, regardless of its key, since there's nothing
/// else it could be — this is what makes it safe for a job with exactly one
/// item even though its key will never match `key` (a real generation id).
fn find_inlined_entry<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    if let Some(entry) = find_by_metadata_key(v, key) {
        return Some(entry);
    }
    let mut entries = Vec::new();
    collect_metadata_entries(v, &mut entries);
    if entries.len() == 1 {
        return entries.into_iter().next();
    }
    None
}

// ---- HTTP calls ----

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
        if status.as_u16() == 429 {
            // Rate-limited: return the sentinel immediately rather than
            // retrying internally, so the caller can requeue the job and back
            // off concurrency instead of burning attempts on a wall that
            // won't clear in seconds.
            return Err(AttemptError::Fatal(RATE_LIMITED_ERROR.to_string()));
        }
        let msg = find_error_message(&parsed).unwrap_or(body);
        let full = format!("Gemini API error ({}): {}", status, msg);
        return Err(if is_retryable_status(status.as_u16()) {
            AttemptError::Retryable(full)
        } else {
            AttemptError::Fatal(full)
        });
    }

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

/// Builds the batch payload for one or more `(key, GenerateRequest)` items,
/// one `InlineRequest` each tagged with its own `metadata.key` (used later by
/// `find_inlined_entry` to pick its result back out of the response).
fn build_payload(items: Vec<(String, GenerateRequest)>) -> Result<CreateBatchRequest, String> {
    let mut requests = Vec::with_capacity(items.len());
    for (key, req) in items {
        let (mime_type, data) = parse_data_uri(&req.image_data_uri)?;
        requests.push(InlineRequest {
            request: GenerateContentRequest {
                contents: vec![Content {
                    parts: vec![
                        Part::Text { text: req.prompt },
                        Part::Inline {
                            inline_data: InlineData { mime_type, data },
                        },
                    ],
                }],
                generation_config: GenerationConfig {
                    response_modalities: vec!["TEXT", "IMAGE"],
                },
            },
            metadata: RequestMetadata { key },
        });
    }

    Ok(CreateBatchRequest {
        batch: Batch {
            display_name: "SABI".to_string(),
            input_config: InputConfig {
                requests: RequestList { requests },
            },
        },
    })
}

/// POSTs a batch payload (one or many items), retrying transient failures
/// with exponential backoff. Shared by `create` and `create_batch` — the
/// payload's item count is the only difference between them.
async fn submit_with_retries(
    api_key: &str,
    payload: &CreateBatchRequest,
) -> Result<CreateOutcome, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut last_err = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        match try_create(&client, api_key, payload).await {
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

// ---- interactions request/response ----

/// Builds the Interactions payload for one request. Unlike `build_payload`,
/// there's no per-item `metadata.key` — one call always produces exactly one
/// result, so there's nothing to disambiguate.
fn build_interaction_payload(req: &GenerateRequest) -> Result<CreateInteractionRequest, String> {
    let (mime_type, data) = parse_data_uri(&req.image_data_uri)?;
    Ok(CreateInteractionRequest {
        // A bare model id is accepted — a live call with this got past model
        // validation all the way to rejecting the (then-nested)
        // response_modalities field, so a bad model name would have errored
        // first.
        model: MODEL.to_string(),
        input: vec![
            InteractionContent::Text {
                text: req.prompt.clone(),
            },
            InteractionContent::Image { mime_type, data },
        ],
        // Unlike Batch's generateContent (which uses uppercase "TEXT"/"IMAGE"),
        // the Interactions API rejects uppercase values here — confirmed live:
        // "The value 'TEXT' is not supported for 'response_modalities[0]'.
        // Supported values: 'text', 'image', 'audio', 'video', 'document'."
        response_modalities: vec!["text", "image"],
    })
}

/// Whether a (successful-status) Interactions response represents a terminal
/// failure — its `status` field, not the batch job's `state`.
fn interaction_failed(v: &serde_json::Value) -> Option<String> {
    let status = v.get("status").and_then(|s| s.as_str())?;
    if status.eq_ignore_ascii_case("failed") || status.eq_ignore_ascii_case("error") {
        Some(find_error_message(v).unwrap_or_else(|| format!("Interaction {}", status)))
    } else {
        None
    }
}

async fn try_create_interaction(
    client: &reqwest::Client,
    api_key: &str,
    payload: &CreateInteractionRequest,
) -> Result<CreateOutcome, AttemptError> {
    let url = format!("{}/interactions", API_BASE);

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
        if status.as_u16() == 429 {
            return Err(AttemptError::Fatal(RATE_LIMITED_ERROR.to_string()));
        }
        let msg = find_error_message(&parsed).unwrap_or(body);
        let full = format!("Gemini API error ({}): {}", status, msg);
        return Err(if is_retryable_status(status.as_u16()) {
            AttemptError::Retryable(full)
        } else {
            AttemptError::Fatal(full)
        });
    }

    if let Some(msg) = interaction_failed(&parsed) {
        return Err(AttemptError::Fatal(msg));
    }

    extract_image(&parsed)
        .map(|(image_bytes, ext)| CreateOutcome::Done { image_bytes, ext })
        .map_err(AttemptError::Fatal)
}

/// POSTs an interaction, retrying transient failures with the same
/// exponential backoff as `submit_with_retries`. Kept as a full 3-attempt
/// loop even though each call now runs from a detached spawn (see
/// `generation.rs::spawn_interaction`) — since it never blocks the queue
/// drain, a slow retry sequence only delays that one row's own result, not
/// the system.
async fn submit_interaction_with_retries(
    api_key: &str,
    payload: &CreateInteractionRequest,
) -> Result<CreateOutcome, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut last_err = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        match try_create_interaction(&client, api_key, payload).await {
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

// ---- trait impl ----

#[async_trait::async_trait]
impl ImageProvider for GoogleProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            id: "google".to_string(),
            label: "Gemini".to_string(),
            key_hint: "AIza...".to_string(),
            key_url: "https://aistudio.google.com/apikey".to_string(),
        }
    }

    async fn create(&self, req: GenerateRequest) -> Result<CreateOutcome, String> {
        match req.mode {
            ApiMode::Interactions => {
                let api_key = req.api_key.clone();
                let payload = build_interaction_payload(&req)?;
                submit_interaction_with_retries(&api_key, &payload).await
            }
            ApiMode::Batch => {
                let api_key = req.api_key.clone();
                let payload = build_payload(vec![("variant".to_string(), req)])?;
                submit_with_retries(&api_key, &payload).await
            }
        }
    }

    async fn create_batch(
        &self,
        items: Vec<(String, GenerateRequest)>,
    ) -> Result<CreateOutcome, String> {
        // Only ever called with Batch-mode items — `pack_into_batches` in
        // generation.rs keeps Interactions-mode rows as singleton groups,
        // since `CreateOutcome` can't represent N independent per-row
        // results from one call. Ignores `.mode` accordingly.
        let api_key = items
            .first()
            .map(|(_, req)| req.api_key.clone())
            .ok_or("create_batch called with no items")?;
        let payload = build_payload(items)?;
        submit_with_retries(&api_key, &payload).await
    }

    async fn poll(&self, poll_url: &str, api_key: &str, key: &str) -> Result<PollOutcome, String> {
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

        if ends("FAILED") || ends("CANCELLED") || ends("EXPIRED") || (done && error.is_some()) {
            let msg = error
                .or_else(|| find_text(&parsed))
                .or_else(|| state.clone())
                .unwrap_or_else(|| "Gemini batch job failed".to_string());
            return Ok(PollOutcome::Failed {
                error: msg,
                logs: None,
            });
        }

        if done || ends("SUCCEEDED") {
            // Scope to this row's own entry when the response is per-item
            // shaped (a batch of >1); falls back to the whole document (this
            // row's own job, or an unrecognized shape) via `unwrap_or`, so
            // this can't regress below the old whole-document search.
            let scope = find_inlined_entry(&parsed, key).unwrap_or(&parsed);
            return match extract_image(scope) {
                Ok((image_bytes, ext)) => Ok(PollOutcome::Done {
                    image_bytes,
                    ext,
                    logs: None,
                }),
                Err(msg) => Ok(PollOutcome::Failed {
                    error: find_error_message(scope).or(error).unwrap_or(msg),
                    logs: None,
                }),
            };
        }

        Ok(PollOutcome::Pending { logs: None })
    }
}
