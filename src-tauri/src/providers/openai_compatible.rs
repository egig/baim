use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde::Serialize;
use uuid::Uuid;

use crate::provider::{
    CreateOutcome, GenerateRequest, ImageProvider, PollOutcome, ProviderInfo, RATE_LIMITED_ERROR,
};

const REQUEST_TIMEOUT_SECS: u64 = 120;
const MAX_ATTEMPTS: u32 = 3;
/// Cap on concurrent outbound requests a single `create_batch` fans out to its
/// endpoint, independent of how many items the caller hands it — a large
/// group would otherwise fire every item as one simultaneous burst, plausibly
/// triggering a rate limit that a smaller fan-out would have avoided.
const MAX_CONCURRENT_ITEMS: usize = 4;
/// The sentinel item key used by `create()`'s single-item batch — its
/// `GenerateRequest` carries no row id, so there's nothing else to key it by.
/// `poll()`'s single-entry fallback (mirroring `google.rs::find_inlined_entry`)
/// is what makes this resolvable later.
const SINGLE_ITEM_KEY: &str = "__single__";
const POLL_URL_PREFIX: &str = "openai-compat-batch://";

// ---- config ----

#[derive(Clone)]
struct Config {
    base_url: String,
    model: String,
}

static CONFIG: Mutex<Option<Config>> = Mutex::new(None);

/// Sets the Base URL and Model id used for every subsequent call. A `Mutex`
/// (not `OnceLock`) since both are user-editable at runtime from the settings
/// UI, not just set once at startup — same pattern as Recraftory's endpoint
/// used to be.
pub fn set_config(base_url: String, model: String) {
    let base_url = base_url.trim_end_matches('/').to_string();
    *CONFIG.lock().unwrap() = Some(Config { base_url, model });
}

fn config() -> Result<Config, String> {
    CONFIG
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "OpenAI-compatible provider not configured (set a Base URL and Model id in Settings)".to_string())
}

// ---- local job registry ----
//
// There's no remote job queue for a synchronous chat-completions call, so
// batching is faked locally: `create`/`create_batch` spawn one tokio task per
// item and return a synthetic `poll_url` immediately; `poll` reads this map
// instead of making a network call. If the app restarts mid-batch, spawned
// tasks die with the old process and this map starts empty again — `poll`
// treats an unknown batch id as an interrupted generation (see `poll`) rather
// than hanging forever.

enum ItemOutcome {
    Running,
    Done { image_bytes: Vec<u8>, ext: String },
    Failed { error: String },
}

static REGISTRY: Mutex<Option<HashMap<String, HashMap<String, ItemOutcome>>>> = Mutex::new(None);

fn new_batch(keys: &[String]) -> String {
    let batch_id = Uuid::new_v4().to_string();
    let mut registry = REGISTRY.lock().unwrap();
    registry.get_or_insert_with(HashMap::new).insert(
        batch_id.clone(),
        keys.iter()
            .map(|k| (k.clone(), ItemOutcome::Running))
            .collect(),
    );
    batch_id
}

fn set_item_outcome(batch_id: &str, key: &str, outcome: ItemOutcome) {
    let mut registry = REGISTRY.lock().unwrap();
    if let Some(items) = registry.get_or_insert_with(HashMap::new).get_mut(batch_id) {
        items.insert(key.to_string(), outcome);
    }
}

/// Reads (and, if terminal, removes) one item's outcome. Exact key match
/// first; if that misses and the batch has exactly one entry, falls back to
/// it regardless of key — the same trick `google.rs::find_inlined_entry` uses,
/// needed here because `create()`'s singleton batch is stored under
/// `SINGLE_ITEM_KEY`, not the caller's real row id.
fn poll_item(batch_id: &str, key: &str) -> Result<PollOutcome, String> {
    let mut registry = REGISTRY.lock().unwrap();
    let items = match registry.get_or_insert_with(HashMap::new).get_mut(batch_id) {
        Some(items) => items,
        None => {
            return Ok(PollOutcome::Failed {
                error: "Generation interrupted — app was closed before it finished, please retry"
                    .to_string(),
                logs: None,
            })
        }
    };

    let resolved_key = if items.contains_key(key) {
        Some(key.to_string())
    } else if items.len() == 1 {
        items.keys().next().cloned()
    } else {
        None
    };

    let Some(resolved_key) = resolved_key else {
        return Ok(PollOutcome::Pending { logs: None });
    };

    let is_terminal = matches!(
        items.get(&resolved_key),
        Some(ItemOutcome::Done { .. }) | Some(ItemOutcome::Failed { .. })
    );

    if !is_terminal {
        return Ok(PollOutcome::Pending { logs: None });
    }

    let outcome = items.remove(&resolved_key).unwrap();
    let items_now_empty = items.is_empty();
    if items_now_empty {
        registry.as_mut().unwrap().remove(batch_id);
    }
    drop(registry);

    match outcome {
        ItemOutcome::Done { image_bytes, ext } => Ok(PollOutcome::Done {
            image_bytes,
            ext,
            logs: None,
        }),
        ItemOutcome::Failed { error } => Ok(PollOutcome::Failed { error, logs: None }),
        ItemOutcome::Running => unreachable!("checked is_terminal above"),
    }
}

// ---- request/response shapes ----

#[derive(Serialize)]
struct ChatCompletionsRequest {
    model: String,
    messages: Vec<Message>,
    modalities: Vec<&'static str>,
}

#[derive(Serialize)]
struct Message {
    role: &'static str,
    content: Vec<ContentPart>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrl },
}

#[derive(Serialize)]
struct ImageUrl {
    url: String,
}

fn build_request(model: &str, prompt: &str, image_data_uri: &str) -> ChatCompletionsRequest {
    ChatCompletionsRequest {
        model: model.to_string(),
        messages: vec![Message {
            role: "user",
            content: vec![
                ContentPart::Text {
                    text: prompt.to_string(),
                },
                ContentPart::ImageUrl {
                    image_url: ImageUrl {
                        url: image_data_uri.to_string(),
                    },
                },
            ],
        }],
        modalities: vec!["image", "text"],
    }
}

/// Recursively walks a JSON response for the first string starting with
/// `data:image` — tolerant of exactly which key nests it (OpenRouter currently
/// uses `choices[0].message.images[].image_url.url`) without hardcoding one
/// path, same spirit as `google.rs`'s recursive `find_*` helpers.
fn find_data_uri(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) if s.starts_with("data:image") => Some(s.clone()),
        serde_json::Value::Object(map) => map.values().find_map(find_data_uri),
        serde_json::Value::Array(arr) => arr.iter().find_map(find_data_uri),
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

fn ext_for_mime(mime: &str) -> String {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
    .to_string()
}

fn decode_data_uri(uri: &str) -> Result<(Vec<u8>, String), String> {
    let rest = uri
        .strip_prefix("data:")
        .ok_or("Response image is not a data URI")?;
    let (meta, data) = rest
        .split_once(',')
        .ok_or("Malformed response image data URI")?;
    let mime = meta.split(';').next().filter(|m| !m.is_empty()).unwrap_or("image/png");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("Failed to decode response image: {}", e))?;
    Ok((bytes, ext_for_mime(mime)))
}

fn is_retryable_status(status: u16) -> bool {
    matches!(status, 500 | 502 | 503 | 504)
}

enum AttemptError {
    Retryable(String),
    Fatal(String),
}

async fn try_call(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    payload: &ChatCompletionsRequest,
) -> Result<(Vec<u8>, String), AttemptError> {
    let url = format!("{}/chat/completions", base_url);

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(payload)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() || e.is_connect() {
                AttemptError::Retryable(format!("Failed to reach endpoint: {}", e))
            } else {
                AttemptError::Fatal(format!("Failed to reach endpoint: {}", e))
            }
        })?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AttemptError::Fatal(format!("Failed to read response: {}", e)))?;

    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        AttemptError::Fatal(format!("Failed to parse response: {} — body: {}", e, body))
    })?;

    if !status.is_success() {
        if status.as_u16() == 429 {
            return Err(AttemptError::Fatal(RATE_LIMITED_ERROR.to_string()));
        }
        let msg = find_error_message(&parsed).unwrap_or(body);
        let full = format!("OpenAI-compatible API error ({}): {}", status, msg);
        return Err(if is_retryable_status(status.as_u16()) {
            AttemptError::Retryable(full)
        } else {
            AttemptError::Fatal(full)
        });
    }

    let data_uri = find_data_uri(&parsed).ok_or_else(|| {
        AttemptError::Fatal(format!("Response contained no image: {}", body))
    })?;

    decode_data_uri(&data_uri).map_err(AttemptError::Fatal)
}

async fn call_with_retries(
    base_url: &str,
    api_key: &str,
    payload: &ChatCompletionsRequest,
) -> Result<(Vec<u8>, String), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut last_err = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        match try_call(&client, base_url, api_key, payload).await {
            Ok(result) => return Ok(result),
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
        "Endpoint unavailable after {} attempts: {}",
        MAX_ATTEMPTS, last_err
    ))
}

/// Spawns one item's call as a background task that writes its own terminal
/// outcome into `REGISTRY[batch_id][key]` once done — never awaited by the
/// caller, which returns `Pending` immediately.
fn spawn_item(
    batch_id: String,
    key: String,
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    image_data_uri: String,
    semaphore: Arc<tokio::sync::Semaphore>,
) {
    tauri::async_runtime::spawn(async move {
        let _permit = semaphore.acquire().await;
        let payload = build_request(&model, &prompt, &image_data_uri);
        let outcome = match call_with_retries(&base_url, &api_key, &payload).await {
            Ok((image_bytes, ext)) => ItemOutcome::Done { image_bytes, ext },
            Err(error) => ItemOutcome::Failed { error },
        };
        set_item_outcome(&batch_id, &key, outcome);
    });
}

// ---- chat (text, tool-calling) ----
//
// Separate from the image-generation path above: a plain, synchronous
// `/chat/completions` call (no `modalities` override, no background
// task/registry) used by the persistent AI chat pane (see `chat.rs`). Reuses
// this module's `config()`/`ContentPart`/`find_error_message` since it's the
// same endpoint shape, just a different payload and response parse.

/// One turn to send as context, already resolved to what the wire format
/// needs — `chat.rs` builds this list from the persisted thread.
pub struct ChatTurnInput {
    /// `"system"`, `"user"`, or `"assistant"`.
    pub role: String,
    pub text: String,
    /// Attached images for this turn (empty for assistant turns and
    /// image-less user turns), already read off disk and encoded.
    pub image_data_uris: Vec<String>,
}

/// What the model produced: plain text, or a request to call the one tool
/// it's offered (`generate_image`).
pub enum ChatReply {
    Text(String),
    ToolCall { name: String, arguments: serde_json::Value },
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatReqMessage>,
    tools: Vec<ToolDef>,
}

#[derive(Serialize)]
struct ChatReqMessage {
    role: &'static str,
    content: ChatContent,
}

#[derive(Serialize)]
#[serde(untagged)]
enum ChatContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Serialize)]
struct ToolDef {
    #[serde(rename = "type")]
    kind: &'static str,
    function: ToolFunctionDef,
}

#[derive(Serialize)]
struct ToolFunctionDef {
    name: &'static str,
    description: &'static str,
    parameters: serde_json::Value,
}

fn generate_image_tool() -> ToolDef {
    ToolDef {
        kind: "function",
        function: ToolFunctionDef {
            name: "generate_image",
            description: "Generate an edited variant of the image attached to the user's most recent message, from a text prompt describing the desired change. Requires an attached image — if the latest user message has none, do not call this; ask the user to attach one instead.",
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "A description of the desired change to make to the attached image."
                    }
                },
                "required": ["prompt"]
            }),
        },
    }
}

/// Send the whole turn history (oldest first) to the configured
/// OpenAI-compatible endpoint and return either its text reply or a
/// `generate_image` tool call. A single attempt, no retry — chat is
/// interactive, so a fast failure the user can just resend beats the image
/// path's patient backoff.
pub async fn chat_complete(api_key: &str, turns: &[ChatTurnInput]) -> Result<ChatReply, String> {
    let cfg = config()?;

    let messages: Vec<ChatReqMessage> = turns
        .iter()
        .map(|t| {
            let role = match t.role.as_str() {
                "system" => "system",
                "assistant" => "assistant",
                _ => "user",
            };
            let content = if t.image_data_uris.is_empty() {
                ChatContent::Text(t.text.clone())
            } else {
                let mut parts = vec![ContentPart::Text {
                    text: t.text.clone(),
                }];
                parts.extend(t.image_data_uris.iter().map(|uri| ContentPart::ImageUrl {
                    image_url: ImageUrl { url: uri.clone() },
                }));
                ChatContent::Parts(parts)
            };
            ChatReqMessage { role, content }
        })
        .collect();

    let payload = ChatRequest {
        model: cfg.model,
        messages,
        tools: vec![generate_image_tool()],
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let url = format!("{}/chat/completions", cfg.base_url);
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to reach endpoint: {}", e))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse response: {} — body: {}", e, body))?;

    if !status.is_success() {
        if status.as_u16() == 429 {
            return Err(RATE_LIMITED_ERROR.to_string());
        }
        let msg = find_error_message(&parsed).unwrap_or(body);
        return Err(format!("Chat API error ({}): {}", status, msg));
    }

    let message = parsed
        .pointer("/choices/0/message")
        .ok_or_else(|| format!("Response contained no message: {}", body))?;

    if let Some(call) = message
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .and_then(|calls| calls.first())
    {
        let name = call
            .pointer("/function/name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let args_str = call
            .pointer("/function/arguments")
            .and_then(|v| v.as_str())
            .unwrap_or("{}");
        let arguments: serde_json::Value =
            serde_json::from_str(args_str).unwrap_or_else(|_| serde_json::json!({}));
        return Ok(ChatReply::ToolCall { name, arguments });
    }

    let text = message
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(ChatReply::Text(text))
}

// ---- trait impl ----

pub struct OpenAiCompatibleProvider;

#[async_trait::async_trait]
impl ImageProvider for OpenAiCompatibleProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            id: "openai_compatible".to_string(),
            label: "OpenAI-compatible".to_string(),
            key_hint: "sk-...".to_string(),
            key_url: "".to_string(),
        }
    }

    async fn create(&self, req: GenerateRequest) -> Result<CreateOutcome, String> {
        let cfg = config()?;
        let batch_id = new_batch(&[SINGLE_ITEM_KEY.to_string()]);
        spawn_item(
            batch_id.clone(),
            SINGLE_ITEM_KEY.to_string(),
            cfg.base_url,
            req.api_key,
            cfg.model,
            req.prompt,
            req.image_data_uri,
            Arc::new(tokio::sync::Semaphore::new(1)),
        );
        Ok(CreateOutcome::Pending {
            poll_url: format!("{}{}", POLL_URL_PREFIX, batch_id),
        })
    }

    async fn create_batch(
        &self,
        items: Vec<(String, GenerateRequest)>,
    ) -> Result<CreateOutcome, String> {
        let cfg = config()?;
        if items.is_empty() {
            return Err("create_batch called with no items".to_string());
        }

        let keys: Vec<String> = items.iter().map(|(key, _)| key.clone()).collect();
        let batch_id = new_batch(&keys);
        let semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_ITEMS));

        for (key, req) in items {
            spawn_item(
                batch_id.clone(),
                key,
                cfg.base_url.clone(),
                req.api_key,
                cfg.model.clone(),
                req.prompt,
                req.image_data_uri,
                semaphore.clone(),
            );
        }

        Ok(CreateOutcome::Pending {
            poll_url: format!("{}{}", POLL_URL_PREFIX, batch_id),
        })
    }

    async fn poll(&self, poll_url: &str, _api_key: &str, key: &str) -> Result<PollOutcome, String> {
        let batch_id = poll_url
            .strip_prefix(POLL_URL_PREFIX)
            .ok_or_else(|| format!("Not an OpenAI-compatible poll URL: {}", poll_url))?;
        poll_item(batch_id, key)
    }
}

