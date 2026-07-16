use serde::Serialize;

/// A single image-generation request, normalized across providers. The app only
/// edits one source image with a text prompt, so that is all a provider needs.
pub struct GenerateRequest {
    pub prompt: String,
    pub image_data_uri: String,
    pub api_key: String,
    /// For meta-providers (e.g. Cloud) that need to forward a downstream
    /// provider's API key alongside their own auth key. Direct providers
    /// (Google, Local) set this to `None`.
    pub provider_api_key: Option<String>,
}

/// What a provider returns from `create`. Async providers (Google/Gemini) hand
/// back a poll URL and finish later; synchronous providers hand back image
/// bytes directly, so the orchestrator can save them immediately.
pub enum CreateOutcome {
    Pending { poll_url: String },
    #[allow(dead_code)]
    Done { image_bytes: Vec<u8>, ext: String },
}

/// The result of polling a pending generation once. Each variant carries the
/// provider's `logs` when available.
pub enum PollOutcome {
    Pending { logs: Option<String> },
    Done {
        image_bytes: Vec<u8>,
        ext: String,
        logs: Option<String>,
    },
    Failed {
        error: String,
        logs: Option<String>,
    },
}

/// Metadata describing a provider, surfaced to the frontend so the settings UI
/// is fully data-driven.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderInfo {
    pub id: String,
    pub label: String,
    pub key_hint: String,
    pub key_url: String,
}

/// The abstraction every image backend implements. `create` kicks off a job;
/// async providers return `Pending { poll_url }` and are advanced later via
/// `poll`, while synchronous providers return `Done` and never poll.
#[async_trait::async_trait]
pub trait ImageProvider: Send + Sync {
    fn info(&self) -> ProviderInfo;
    async fn create(&self, req: GenerateRequest) -> Result<CreateOutcome, String>;

    /// Submit multiple requests as a single batch job sharing one poll URL,
    /// for providers whose backend supports true batching. Each item is
    /// tagged with its own `key`, later used by `poll` to pick its result out
    /// of a multi-item response. Default: only meaningful for exactly one
    /// item (delegates to `create`); providers that can't batch return `Err`
    /// for more, rather than silently splitting into separate jobs (which
    /// would break the "one poll_url for the whole group" contract callers
    /// rely on).
    async fn create_batch(
        &self,
        mut items: Vec<(String, GenerateRequest)>,
    ) -> Result<CreateOutcome, String> {
        if items.len() == 1 {
            let (_, req) = items.pop().unwrap();
            return self.create(req).await;
        }
        Err("Batched generation not supported by this provider".to_string())
    }

    /// `key` identifies which request's result to extract when `poll_url`
    /// points at a multi-item batch job (see `create_batch`); providers that
    /// never batch can ignore it.
    async fn poll(&self, poll_url: &str, api_key: &str, key: &str) -> Result<PollOutcome, String>;
}

/// The identifier assumed when none is stored (existing rows, fresh installs).
pub const DEFAULT_PROVIDER: &str = "google";

/// Sentinel error returned by `RecraftoryProvider::create` when the Recraftory
/// backend responds 402 (insufficient credit balance), so callers can distinguish
/// "out of credits" from a generic generation failure without a structured
/// per-provider error type.
pub const OUT_OF_CREDITS_ERROR: &str = "OUT_OF_CREDITS";

/// Sentinel error returned by `ImageProvider::create` when the provider
/// rate-limited the request (e.g. Gemini's 429). Distinct from a generic
/// failure so callers can requeue the job and back off concurrency instead of
/// surfacing it as a dead `failed` row.
pub const RATE_LIMITED_ERROR: &str = "RATE_LIMITED";
