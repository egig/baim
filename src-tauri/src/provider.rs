use serde::Serialize;

/// A single image-generation request, normalized across providers. The app only
/// edits one source image with a text prompt, so that is all a provider needs.
pub struct GenerateRequest {
    pub prompt: String,
    pub image_data_uri: String,
    pub api_key: String,
}

/// What a provider returns from `create`. Async providers (Google/Gemini) hand
/// back a poll URL and finish later; synchronous providers hand back image
/// bytes directly, so the orchestrator can save them immediately.
pub enum CreateOutcome {
    // Async providers (Google/Gemini) return a poll URL, advanced later by
    // `poll`.
    Pending { poll_url: String },
    // Synchronous providers return the image bytes directly, saved immediately.
    // No registered provider is synchronous today, but the orchestrator still
    // handles this so adding one needs no plumbing changes.
    #[allow(dead_code)]
    Done { image_bytes: Vec<u8>, ext: String },
}

/// The result of polling a pending generation once. Each variant carries the
/// provider's `logs` when available (Google's Batch API has none, so it
/// returns `None`; a future provider may stream real logs), so the orchestrator
/// can persist the latest logs on every poll — including while still pending.
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
/// (dropdown, key placeholder, "get a key" link) is fully data-driven.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderInfo {
    pub id: String,
    pub label: String,
    /// Placeholder shown in the API-key input (e.g. Google's `AIza...`).
    pub key_hint: String,
    /// Where the user obtains a key for this provider.
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

/// The provider registry. Adding a provider is a two-line change: implement
/// `ImageProvider` and add it here — the settings dropdown, per-provider keys,
/// and per-generation dispatch are all driven off this list.
pub fn all_providers() -> Vec<Box<dyn ImageProvider>> {
    vec![Box::new(crate::providers::google::GoogleProvider)]
}

/// Look up a provider by its id, if registered.
pub fn get_provider(id: &str) -> Option<Box<dyn ImageProvider>> {
    all_providers().into_iter().find(|p| p.info().id == id)
}

/// The metadata for every registered provider, for the frontend.
pub fn provider_infos() -> Vec<ProviderInfo> {
    all_providers().iter().map(|p| p.info()).collect()
}
