# TODO: Cloud Backend

## Phase 1: Shared Rust Crate (`sabi/`)

- [x] Create `sabi/Cargo.toml` (workspace member)
- [x] Move `ImageProvider` trait + types to `sabi/src/provider.rs`
- [x] Move `GoogleProvider` to `sabi/src/providers/google.rs`
- [x] Update `src-tauri/` to depend on `sabi`
- [x] Strip `src-tauri/src/provider.rs` down to registry + re-exports
- [x] Make `src-tauri/src/providers/google.rs` a re-export
- [x] Verify `cargo build` works

## Phase 2: Cloud Backend (`packages/cloud-backend/`)

- [ ] Scaffold Worker project with `hono`
- [ ] Create D1 database + R2 bucket
- [ ] Write `src/domain/` — Job, User, Image entities + repository interfaces
- [ ] Write `src/infrastructure/d1/` — D1 repository implementations
- [ ] Write `src/infrastructure/r2/` — R2 image store
- [ ] Write `src/infrastructure/providers/gemini.ts` — Gemini Batch API client
- [ ] Write `src/application/` — job service, auth service
- [ ] Write `src/workers/api.ts` — Hono router with all endpoints
- [ ] Write `src/workers/cron.ts` — poll pending jobs (30s interval)
- [ ] Write `src/workers/queue.ts` — submit queued jobs
- [ ] Write `migrations/001_init.sql`
- [ ] Wire up `src/index.ts` as composition root
- [ ] Configure `wrangler.toml` with bindings + cron trigger

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
