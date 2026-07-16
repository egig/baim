// Re-export shared types from catalog-core.
pub use sabi::provider::{
    CreateOutcome, GenerateRequest, ImageProvider, PollOutcome, ProviderInfo, DEFAULT_PROVIDER,
    RATE_LIMITED_ERROR,
};

/// Every provider registered in this application. Adding a provider is a
/// two-line change: implement `ImageProvider` (in its own module) and add it
/// here — the per-provider keys and per-generation dispatch are all driven
/// off this list.
///
/// TODO: `RecraftoryProvider` is implemented but not production-ready (see
/// `providers/recraftory.rs`) — re-add it here once the cloud backend is
/// ready to ship.
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
