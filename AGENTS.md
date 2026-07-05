# AGENTS.md

**Last updated**: 2026-07-05 (provider abstraction: `ImageProvider` trait +
global provider selection)

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
| `generation.rs` | Provider-agnostic orchestration (`create_prediction`/`refresh_generation`), image save/delete, storage dir, `ImageEntry`/`Generation` types |
| `db.rs` | SQLite queries for `images` and `generations` tables |

Commands: `create_prediction`, `refresh_generation`, `list_providers`,
`get_active_provider`, `set_active_provider`, `get_images`, `get_generations`,
`delete_image`, `save_uploaded_image`, `get_storage_dir`, `set_storage_dir`.

### Provider abstraction

Image generation is abstracted behind the `ImageProvider` trait
(`provider.rs`). Adding a provider = implement the trait + add it to
`all_providers()`; the settings dropdown, per-provider API-key inputs, and
per-generation dispatch are all driven off that registry. Replicate is currently
the only registered provider. The trait supports both async-poll providers
(`CreateOutcome::Pending { poll_url }`, advanced by `poll`) and synchronous ones
(`CreateOutcome::Done { image_bytes }`, saved immediately). The active provider
is a **global choice** stored in the DB `settings` table (`active_provider` key)
and each `generations` row records the `provider` that produced it.

### Key constraints

- **Database-driven** — SQLite at `<app-data>/com.catalog-image-generator.app/catalog.db`
  (`dirs::data_dir()`, **not** inside the image storage folder — so the app
  always boots and the folder can be relocated). `get_images` /
  `get_generations` query the DB, not the filesystem. On startup,
  `seed_from_disk()` idempotently populates the DB from existing files in the
  configured storage dir.
- **API key** — stored in `localStorage` per provider under key
  `<provider_id>_api_key` (Replicate keeps the historical `replicate_api_key`),
  passed as a param on `create_prediction`/`refresh_generation`. No server-side
  secret storage. The `provider` id is passed alongside on `create_prediction`;
  `refresh_generation` reads it from the stored generation row.
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
- **Polling** — `create_prediction` returns immediately (async mode). Frontend
  drives `refresh_generation` via `pollUntilDone()` (45 attempts, 2s interval)
  in `assets.tsx:91`.
- **Upload normalization** — uploaded images are converted to PNG data URIs
  client-side (canvas re-encode) via `fileToDataUri()` in `assets.tsx`.
  Images are **saved to the DB and filesystem immediately on pick**
  (not deferred until generation), via `save_uploaded_image`.
- **Path safety** — `delete_image` canonicalizes paths and rejects anything
  outside the images directory.
- **Rust deps**: `reqwest` (HTTP), `rusqlite` (SQLite), `serde`/`serde_json`,
  `uuid`, `dirs`, `tokio`, `base64`, `async-trait` (provider trait),
  `tauri-plugin-dialog` (folder picker).
