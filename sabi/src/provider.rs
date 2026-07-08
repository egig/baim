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
    async fn poll(&self, poll_url: &str, api_key: &str) -> Result<PollOutcome, String>;
}

/// The identifier assumed when none is stored (existing rows, fresh installs).
pub const DEFAULT_PROVIDER: &str = "google";
