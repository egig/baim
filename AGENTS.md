# AGENTS.md

**Last updated**: 2026-07-05 (Google/Gemini provider now uses the async Batch API
— `batchGenerateContent` inline job + poll; query-driven frontend polling)

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (port 5173, frontend only) |
| `npm run build` | `tsc -b` typecheck + `vite build` to `dist/` |
| `npm run lint` | oxlint |
| `npx tauri dev` | Full desktop app (spawns Vite via `beforeDevCommand`) |
| `npx tauri build` | Production bundle |
| `cargo check` / `cargo build` (from `src-tauri/`) | Rust backend only |

No test suite.

## Architecture

Tauri v2 app, two halves over `invoke()`.

### Frontend (`src/`)

- React 19 + react-router v8, TypeScript ~6.0
- Tailwind v4 via `@tailwindcss/vite` — imported in `src/index.css` only.
  Components use inline `style` props with CSS custom properties (scoped under
  `.assets-app`), **not** Tailwind utility classes.
- TS quirks: `verbatimModuleSyntax` (use `import type`), `erasableSyntaxOnly`
  (no enums, no namespaces).
- **Routes** (`src/main.tsx`):
  - `/` → `routes/assets.tsx` — asset library (main page)
  - `/settings` → `routes/settings.tsx` — settings page (API key + storage
    location sections; folder picker via `@tauri-apps/plugin-dialog`)
- `src/lib/tauri.ts` — single typed bridge to `invoke()` calls. Add new backend
  calls here, not in components.
- `src/root.tsx` — layout shell with sidebar, exports `Button` component.

### Backend (`src-tauri/src/`)

| File | Role |
|---|---|
| `lib.rs` | Tauri setup: opens DB, runs `seed_from_disk()`, registers commands |
| `commands.rs` | Thin `#[tauri::command]` pass-throughs |
| `provider.rs` | `ImageProvider` trait, `GenerateRequest`/`CreateOutcome`/`PollOutcome`/`ProviderInfo`, and the provider registry (`all_providers`/`get_provider`) |
| `providers/replicate.rs` | Concrete Replicate impl (`google/nano-banana-2`, async poll) |
| `providers/google.rs` | Concrete Google/Gemini impl (async Batch API, `gemini-3.1-flash-image`, `:batchGenerateContent` inline job + poll operation, retries transient 5xx on create) |
| `generation.rs` | Provider-agnostic orchestration (`create_prediction`/`refresh_generation`), image save/delete, storage dir, `ImageEntry`/`Generation` types |
| `db.rs` | SQLite queries for `images` and `generations` tables |

Commands: `create_prediction`, `refresh_generation`, `list_providers`,
`get_active_provider`, `set_active_provider`, `has_api_key`, `set_api_key`,
`get_images`, `get_generations`, `delete_image`, `save_uploaded_image`,
`get_storage_dir`, `set_storage_dir`.

### Provider abstraction

Image generation is abstracted behind the `ImageProvider` trait
(`provider.rs`). Adding a provider = implement the trait + add it to
`all_providers()`; the settings dropdown, per-provider API-key inputs, and
per-generation dispatch are all driven off that registry. Registered providers:
**Replicate** (async, `google/nano-banana-2`) and **Google/Gemini** (async, via
the **Batch API**). Google submits a single-request inline batch job — `POST
{v1beta}/models/gemini-3.1-flash-image:batchGenerateContent` with the prompt as a
text part and the source image as an `inline_data` part, `response_modalities:
[TEXT, IMAGE]` — and returns the operation name as the poll URL; `poll` GETs
`{v1beta}/{operation}` (a long-running `Operation`), keys off its `done` flag
plus the batch `state`, then reads the generated image out of the inline
response. Batch trades latency (target turnaround up to 24h, usually much faster)
for 50% cost and higher rate limits. The Batch REST response is loosely specced —
state appears as `BATCH_STATE_*` (REST) or `JOB_STATE_*` (SDKs) and nests under
`metadata`/`response` — so `google.rs` parses the operation as `serde_json::Value`
and searches defensively (`find_state` by suffix, recursive `find_inline_image`
and `find_error_message`) rather than relying on a fixed shape. Both
registered providers are async-poll (`CreateOutcome::Pending { poll_url }`,
advanced by `poll`); the trait *also* supports synchronous providers
(`CreateOutcome::Done { image_bytes }`, saved immediately) for future backends,
even though none is registered today. The active provider is a **global choice**
stored in the DB `settings` table (`active_provider` key) and each `generations`
row records the `provider` that produced it.

### Key constraints

- **Database-driven** — SQLite at `<app-data>/com.catalog-image-generator.app/catalog.db`
  (`dirs::data_dir()`, **not** inside the image storage folder — so the app
  always boots and the folder can be relocated). `get_images` /
  `get_generations` query the DB, not the filesystem. On startup,
  `seed_from_disk()` idempotently populates the DB from existing files in the
  configured storage dir.
- **API key** — stored server-side in the DB `settings` table per provider
  under key `<provider_id>_api_key` (e.g. `replicate_api_key`). Written via
  `set_api_key` (empty string clears it); the value never leaves the backend —
  the frontend only queries presence via `has_api_key`. Generation reads the key
  from the DB itself: `create_prediction` looks it up by the passed `provider`
  id, `refresh_generation` by the stored generation row's `provider`. Neither
  command takes the key as a param.
- **Storage directory** — user-configurable. Persisted in the DB `settings`
  table (`storage_dir` key), cached on the `Db` struct (`db.storage_dir()`),
  defaults to `~/Pictures/catalog-gen` (`generation::default_storage_dir`).
  Changed via `set_storage_dir` (Settings page → native folder picker).
- **Image files** — saved in the configured storage dir; generated images named
  `<prediction_id>.jpg`, uploads `<uuid>.png`. Served to the frontend via
  `convertFileSrc(path)` (Tauri asset protocol). The static
  `"$HOME/Pictures/catalog-gen/**/*"` scope in `tauri.conf.json` is only the
  default; the configured dir is registered at runtime via
  `app.asset_protocol_scope().allow_directory(dir, true)` (in `lib.rs` setup and
  on every `set_storage_dir`). Requires `protocol-asset` Cargo feature.
  CSP must allow `asset:` and `http://asset.localhost` for `img-src`.
- **Polling** — `create_prediction` returns immediately with a `pending` record.
  Polling is **query-driven**: `assetsQuery` (`src/lib/queries.ts`) has a
  `refetchInterval` that fires every 2s while any generation is `pending`, and its
  `fetchAssets` advances each pending row one step by calling `refresh_generation`
  (via `refreshGeneration(id)`). The interval stops once nothing is pending.
  In-progress generations render as spinner placeholder tiles (`PendingCard` in
  `assets.tsx`); the `generate()` flow is non-blocking (fire, close panel, free
  the button) — the finished image appears when polling completes.
- **Upload normalization** — uploaded images are converted to PNG data URIs
  client-side (canvas re-encode) via `fileToDataUri()` in `assets.tsx`.
  Images are **saved to the DB and filesystem immediately on pick**
  (not deferred until generation), via `save_uploaded_image`.
- **Path safety** — `delete_image` canonicalizes paths and rejects anything
  outside the images directory.
- **Rust deps**: `reqwest` (HTTP), `rusqlite` (SQLite), `serde`/`serde_json`,
  `uuid`, `dirs`, `tokio`, `base64`, `async-trait` (provider trait),
  `tauri-plugin-dialog` (folder picker).
