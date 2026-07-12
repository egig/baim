# AGENTS.md

**Last updated**: 2026-07-08 (renamed project from `catalog-image-generator` to `sabi`)

> **Running on Windows?** Read `TODO-WINDOWS.md` first — it lists known
> Windows-specific issues (title bar config, `\\?\` canonical paths, default
> storage dir) with fixes and verification steps to perform on that machine.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (port 5173, frontend only) |
| `npm run build` | `tsc -b` typecheck + `vite build` to `dist/` |
| `npm run lint` | oxlint |
| `npx tauri dev` | Full desktop app (spawns Vite via `beforeDevCommand`) |
| `npx tauri build` | Production bundle |
| `cargo check` / `cargo build` | Rust workspace (from repo root) |
| `cargo check -p sabi` | Shared crate only |

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
  - `/` → `routes/assets/index.tsx` — asset library (main page); its
    subcomponents live as siblings in `routes/assets/` (see below)
  - `/settings` → `routes/settings.tsx` — settings page (API key + storage
    location sections; folder picker via `@tauri-apps/plugin-dialog`)
- `src/lib/tauri.ts` — single typed bridge to `invoke()` calls. Add new backend
  calls here, not in components.
- `src/root.tsx` — layout shell with sidebar, exports `Button` component.
- **One component per file.** A route file (`routes/*.tsx` or `routes/*/index.tsx`)
  owns page-level state and composition only; every `memo`/exported component it
  used to render inline gets its own file next to it (e.g. `routes/assets/ImageCard.tsx`,
  `routes/assets/DetailPanel.tsx`). A component used by more than one route (e.g.
  `Segmented`) belongs in `src/components/`, not in whichever route first needed
  it. Small pure helpers (formatters, constants) go in a `helpers.ts`/`types.ts`
  next to the route, not inline in a component file. When a route file's inline
  JSX return grows past a couple hundred lines, that's the signal to extract —
  don't wait for a rewrite to fix it.

### Backend (`src-tauri/src/`)

| File | Role |
|---|---|
| `lib.rs` | Tauri setup: opens DB, runs `seed_from_disk()`, registers commands |
| `commands.rs` | Thin `#[tauri::command]` pass-throughs |
| `provider.rs` | Re-exports `ImageProvider` trait + types from `sabi`; provider registry (`all_providers`/`get_provider`) |
| `providers/google.rs` | Re-export of GoogleProvider from `sabi` |
| `providers/recraftory.rs` | `RecraftoryProvider` — REST client to cloud backend (Cloudflare Workers) |
| `generation.rs` | Provider-agnostic orchestration (`create_prediction`/`refresh_generation`), image save/delete, storage dir, `ImageEntry`/`Generation` types |
| `db.rs` | SQLite queries for `images` and `generations` tables |

Commands: `create_prediction`, `create_predictions` (batch: one prediction per
prompt), `refresh_generation`, `list_providers`,
`get_active_provider`, `set_active_provider`, `has_api_key`, `set_api_key`,
`get_images`, `get_generations`, `delete_image`, `save_uploaded_image`,
`get_recraftory_endpoint`, `set_recraftory_endpoint`,
`get_storage_dir`, `set_storage_dir`.

### Provider abstraction

Image generation is abstracted behind the `ImageProvider` trait
(`provider.rs`). Adding a provider = implement the trait + add it to
`all_providers()`; the settings dropdown, per-provider API-key inputs, and
per-generation dispatch are all driven off that registry. The trait and the
**Google/Gemini** implementation live in the `sabi` shared crate, used
by both the desktop app and (conceptually) the cloud backend.

**Registered providers:**
- **Google/Gemini** — async, via the **Batch API**. Submits a single-request
  inline batch job (`POST {v1beta}/models/gemini-3.1-flash-image:batchGenerateContent`
  with prompt + source image as `inline_data`, `response_modalities: [TEXT, IMAGE]`),
  returns the operation name as the poll URL. Poll GETs `{v1beta}/{operation}`,
  keys off `done` flag + batch `state`, extracts image from inline response.
  Parses the operation as `serde_json::Value`, searches defensively for state
  (matches `BATCH_STATE_*` or `JOB_STATE_*` by suffix), image (`find_inline_image`),
  and errors. Retries transient 5xx on create with exponential backoff.
- **Recraftory** — REST client to the cloud backend (Cloudflare Workers). Forwards
  jobs to `POST /api/jobs` and polls via `GET /api/jobs/:id`. The downstream
  provider API key (e.g. Gemini) is passed alongside the Recraftory auth key in
  `provider_api_key`.

The active provider is a **global choice** stored in the DB `settings` table
(`active_provider` key) and each `generations` row records the `provider` that
produced it. One-time migrations in `db.rs::init_tables` handle databases
from before provider renames/removals: from when **Replicate** was registered,
`active_provider = 'replicate'` is rewritten to `google`, and unfinished
replicate generations are marked `failed` (finished rows keep
`provider = 'replicate'` as history); from when the cloud provider was named
**`cloud`**, `active_provider`, `generations.provider`, and the
`cloud_api_key`/`cloud_endpoint` settings keys are rewritten to
`recraftory`/`recraftory_api_key`/`recraftory_endpoint`.

### Key constraints

- **Database-driven** — SQLite at `<app-data>/com.recraftory.sabi/catalog.db`
  (`dirs::data_dir()`, **not** inside the image storage folder — so the app
  always boots and the folder can be relocated). `get_images` /
  `get_generations` query the DB, not the filesystem. On startup,
  `seed_from_disk()` idempotently populates the DB from existing files in the
  configured storage dir.
- **API key** — stored server-side in the DB `settings` table per provider
  under key `<provider_id>_api_key` (e.g. `google_api_key`). Written via
  `set_api_key` (empty string clears it); the value never leaves the backend —
  the frontend only queries presence via `has_api_key`. Generation reads the key
  from the DB itself: `create_prediction` looks it up by the passed `provider`
  id, `refresh_generation` by the stored generation row's `provider`. Neither
  command takes the key as a param.
- **Storage directory** — user-configurable. Persisted in the DB `settings`
  table (`storage_dir` key), cached on the `Db` struct (`db.storage_dir()`),
  defaults to `~/Pictures/sabi-images` (`generation::default_storage_dir`).
  Changed via `set_storage_dir` (Settings page → native folder picker).
- **Image files** — saved in the configured storage dir; generated images named
  `<prediction_id>.jpg`, uploads `<uuid>.png`. Served to the frontend via
  `convertFileSrc(path)` (Tauri asset protocol). The static
  `"$HOME/Pictures/sabi-images/**/*"` scope in `tauri.conf.json` is only the
  default; the configured dir is registered at runtime via
  `app.asset_protocol_scope().allow_directory(dir, true)` (in `lib.rs` setup and
  on every `set_storage_dir`). Requires `protocol-asset` Cargo feature.
  CSP must allow `asset:` and `http://asset.localhost` for `img-src`.
- **Polling** — `create_prediction` returns immediately with a `pending` record.
  Polling is **query-driven**: `assetsQuery` (`src/lib/queries.ts`) has a
  `refetchInterval` that fires every 2s while any generation is `pending`, and its
  `fetchAssets` advances each pending row one step by calling `refresh_generation`
  (via `refreshGeneration(id)`). The interval stops once nothing is pending.
  In-progress generations render as spinner placeholder tiles
  (`routes/assets/PendingCard.tsx`); the `generate()` flow is non-blocking (fire,
  close panel, free the button) — the finished image appears when polling
  completes.
- **Upload normalization** — uploaded images are converted to PNG data URIs
  client-side (canvas re-encode) via `fileToDataUri()` in `routes/assets/helpers.ts`.
  Images are **saved to the DB and filesystem immediately on pick**
  (not deferred until generation), via `save_uploaded_image`.
- **Path safety** — `delete_image` canonicalizes paths and rejects anything
  outside the images directory.
- **Rust deps**: `reqwest` (HTTP), `rusqlite` (SQLite), `serde`/`serde_json`,
  `uuid`, `dirs`, `tokio`, `base64`, `async-trait` (provider trait),
  `tauri-plugin-dialog` (folder picker).

### Shared crate (`sabi/`)

Cargo workspace member. Contains the `ImageProvider` trait + types and the
`GoogleProvider` implementation. Used by the desktop app (`src-tauri/`).

### Cloud backend

The Cloudflare Workers + D1 + R2 implementation that `RecraftoryProvider`
(`providers/recraftory.rs`) talks to over REST now lives in a separate project,
[`sabi-cloud`](../sabi-cloud) — see its README for architecture and commands.
