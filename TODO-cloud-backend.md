# TODO: Cloud Backend

## Phase 1: Shared Rust Crate (`baim/`)

- [x] Create `baim/Cargo.toml` (workspace member)
- [x] Move `ImageProvider` trait + types to `baim/src/provider.rs`
- [x] Move `GoogleProvider` to `baim/src/providers/google.rs`
- [x] Update `src-tauri/` to depend on `baim`
- [x] Strip `src-tauri/src/provider.rs` down to registry + re-exports
- [x] Make `src-tauri/src/providers/google.rs` a re-export
- [x] Verify `cargo build` works

## Phase 2: Cloud Backend — moved to [`sabi-cloud`](../sabi-cloud)

Done, and now developed as its own project (was `packages/sabi-cloud/` in
this repo). See that repo's README for its own roadmap.

## Phase 3: CloudProvider (Desktop)

- [ ] Add `src-tauri/src/providers/cloud.rs` — implements `ImageProvider`, REST client to cloud
- [ ] Register in `all_providers()`
- [ ] Add cloud connection settings to desktop UI (endpoint URL + API key)

## Phase 4: Web UI (deferred)

- [ ] Create Vite project in `packages/cloud-web/`
- [ ] Share React components via alias
- [ ] Implement `CloudCatalogApi`
- [ ] Deploy on Cloudflare Pages

## Phase 5: LocalProvider (deferred)

- [ ] Decide backend (ComfyUI / diffusers)
- [ ] Implement `src-tauri/src/providers/local.rs`
- [ ] Register in `all_providers()`
