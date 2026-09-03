# AGENTS.md

**Last updated**: 2026-07-19 (Renamed the app from SABI to Baim: crate
`sabi`→`baim`, app identifier `com.recraftory.sabi`→`com.recraftory.baim`,
registry `sabi.db`→`baim.db`, per-workspace `.sabi/`→`.baim/`. No migration
from the old names — this project predates any real install.)

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
| `cargo check -p baim` | Shared crate only |

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
- **Routes** (`src/main.tsx`): three top-level routes, all nested under
  `<Root>` and reached from the left `Sidebar` (`src/components/Sidebar.tsx`):
  - `/` → `routes/assets/index.tsx` — asset library ("Semua Berkas"); its
    subcomponents live as siblings in `routes/assets/` (see below).
  - `/templates` → `routes/templates/index.tsx` — "Templat": full CRUD over
    saved prompt templates. "Tambah templat" (`TemplateDialog`) creates one
    from scratch — name + prompt + an *optional* preview image (client-
    normalized PNG data URI; templates without one store `preview_path = ""`
    and the card shows a placeholder icon). Each card edits (same dialog) or
    deletes. Templates can *also* be created from "Simpan sebagai templat" in
    the asset detail panel (`SaveTemplateDialog`), which uses that asset as
    the preview.
  - `/history` → `routes/generations.tsx` — "Riwayat": every generation with a
    status filter + detail panel + retry. Was previously a titlebar-triggered
    full-window dialog.
  - Settings (`routes/settings.tsx` — Gemini API key + concurrency ceiling) is
    **not a route**: it's a `Dialog` opened from the Sidebar's footer button
    via the `useShell()` context (`openSettings`).
- The `Sidebar` header hosts `WorkspaceSwitcher`
  (`src/components/WorkspaceSwitcher.tsx`) — the only place the active folder is
  changed (native picker via `@tauri-apps/plugin-dialog`, same as the old
  Settings folder picker). It lives in the sidebar, not a route, because every
  route reads the active workspace.
- `src/lib/tauri.ts` — single typed bridge to `invoke()` calls. Add new backend
  calls here, not in components.
- **i18n** (`src/lib/i18n.tsx` + `src/locales/{en,id}.json`) — English + Indonesian
  UI strings, no library. `I18nProvider` wraps the router in `main.tsx`;
  components call `const { t } = useT()` and `t("area.key", { count })` (dot-path
  lookup, `{name}` interpolation, falls back to `id` then the raw key). The
  choice persists to `localStorage["baim.lang"]`; no saved value → browser locale,
  defaulting to `id`. Switched from the Settings dialog (`LanguageSection`).
  Non-component formatters (`helpers.ts` dates/sizes, `localeCompare`) read
  `localeTag()`/`getLang()` from the same module. **Every user-facing string goes
  through `t()`** — add the key to *both* locale files.
- `src/root.tsx` — layout shell: a bare drag-region `Titlebar`, the `Sidebar`,
  and the routed `<Outlet>`. Owns the settings dialog and the `ShellContext`.
  Exports `Button`, `Dialog`, `ImageViewer`, `useEscapeLayer`, `useShell`.
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
| `lib.rs` | Tauri setup: opens the registry DB, resolves the boot workspace, registers commands |
| `commands.rs` | Thin `#[tauri::command]` pass-throughs |
| `provider.rs` | Re-exports `ImageProvider` trait + types from `baim`; provider registry (`all_providers`/`get_provider`) |
| `providers/google.rs` | Re-export of GoogleProvider from `baim` |
| `providers/recraftory.rs` | `RecraftoryProvider` — REST client to cloud backend (Cloudflare Workers). **TODO: not production-ready**, deliberately excluded from `all_providers()` |
| `generation.rs` | Provider-agnostic orchestration (`create_prediction`/`refresh_generation`), image save/delete, `ImageEntry`/`Generation` types |
| `db.rs` | `WorkspaceDb` — SQLite queries for one workspace's `images`/`generations` tables |
| `registry.rs` | `RegistryDb` — `baim.db`: global settings (API keys, active provider) + the `workspaces` table |
| `workspace.rs` | `AppState`, `WorkspaceHandle`/`WorkspaceInfo`, `open_workspace`/`boot_workspace` — the workspace-switching orchestration |

Commands: `create_prediction`, `create_predictions` (batch: one prediction per
prompt), `refresh_generation`, `list_providers`,
`get_active_provider`, `set_active_provider`, `has_api_key`, `set_api_key`,
`get_images`, `get_generations`, `delete_image`, `save_uploaded_image`,
`get_recraftory_endpoint`, `set_recraftory_endpoint`,
`list_workspaces`, `get_active_workspace`, `open_workspace`,
`forget_workspace`, `list_templates`, `save_template` (from an asset — copies
its file as the preview), `create_template` (from scratch — optional preview
data URI), `update_template` (name + prompt, + preview when a data URI is
given), `rename_template` (name only, used by the inline picker), `delete_template`.

### Provider abstraction

Image generation is abstracted behind the `ImageProvider` trait
(`provider.rs`). Adding a provider = implement the trait + add it to
`all_providers()`; the per-provider API-key input and per-generation dispatch
are driven off that registry. Since only one provider is registered,
`routes/settings.tsx` renders its API-key input directly — no provider
switcher. The trait and the **Google/Gemini** implementation live in the
`baim` shared crate, used by both the desktop app and (conceptually) the
cloud backend.

**Registered providers:**
- **Google/Gemini** — async, via the **Batch API**. Submits a single-request
  inline batch job (`POST {v1beta}/models/gemini-3.1-flash-image:batchGenerateContent`
  with prompt + source image as `inline_data`, `response_modalities: [TEXT, IMAGE]`),
  returns the operation name as the poll URL. Poll GETs `{v1beta}/{operation}`,
  keys off `done` flag + batch `state`, extracts image from inline response.
  Parses the operation as `serde_json::Value`, searches defensively for state
  (matches `BATCH_STATE_*` or `JOB_STATE_*` by suffix), image (`find_inline_image`),
  and errors. Retries transient 5xx on create with exponential backoff.

**Not registered (TODO):**
- **Recraftory** (`providers/recraftory.rs`) — REST client to the cloud
  backend (Cloudflare Workers). Forwards jobs to `POST /api/jobs` and polls
  via `GET /api/jobs/:id`. The downstream provider API key (e.g. Gemini) is
  passed alongside the Recraftory auth key in `provider_api_key`. Implemented
  but not production-ready, so it's deliberately left out of
  `all_providers()` and has no UI (no settings section, no provider
  switcher) until the cloud backend is ready to ship. Re-add it to
  `all_providers()` to bring it back.

The active provider is a **global choice** stored in the registry's `settings`
table (`active_provider` key) and each `generations` row (in whichever
workspace produced it) records the `provider` that produced it. One-time
migrations handle databases from before provider renames/removals, split
across both DB types since `active_provider`/API-key settings live in the
registry but `generations.provider` lives per-workspace: from when
**Replicate** was registered, `registry.rs::init_tables` rewrites
`active_provider = 'replicate'` to `google`, and `db.rs::init_tables` (run for
every workspace) marks unfinished replicate generations `failed` (finished
rows keep `provider = 'replicate'` as history); from when the cloud provider
was named **`cloud`**, `registry.rs::init_tables` rewrites `active_provider`
and the `cloud_api_key`/`cloud_endpoint` settings keys, while
`db.rs::init_tables` rewrites `generations.provider` — both to
`recraftory`/`recraftory_api_key`/`recraftory_endpoint`.

### Key constraints

- **Workspaces** — a workspace is a user-picked folder; images/generations
  live in `<folder>/.baim/catalog.db` (a `WorkspaceDb`), so a workspace is
  self-contained and portable (copy/move the folder, its history comes with
  it). Exactly **one workspace is active** at a time (`AppState.workspace:
  Mutex<Arc<WorkspaceHandle>>` in `workspace.rs`), swapped wholesale by
  `open_workspace` — never mutated in place. `get_images`/`get_generations`/
  `create_prediction`/etc. all operate on the active workspace; none take a
  workspace param, they read `AppState` via `active_workspace()`.
  - **First-ever launch** (no known workspaces): auto-opens a default
    workspace at `~/Pictures/baim-images` (`generation::default_storage_dir`),
    same zero-friction boot as before workspaces existed.
  - **Later launches**: `workspace::boot_workspace` reopens the last-active
    path (`baim.db` setting `active_workspace_path`), falling back through the
    recents list, then the default, if that path is now missing — the app
    never fails to boot for a missing folder.
  - **Switching** (`open_workspace`): canonicalize → create `.baim/` + init
    its catalog if new → `seed_from_disk` → register the asset-protocol scope
    → only then commit to the registry and swap `AppState.workspace`, so a
    failure at any step leaves the previously active workspace untouched.
  - A workspace's display name is always its **live folder basename** —
    never stored, so it can't drift out of sync with a rename on disk.
  - **Known limitation**: a workspace that isn't active stops being polled
    client-side (see Polling below) — its pending jobs resume advancing once
    it's reopened.
- **`baim.db` registry** — SQLite at `<app-data>/com.recraftory.baim/baim.db`
  (`RegistryDb` in `registry.rs`), a single always-open connection distinct
  from the active workspace's `WorkspaceDb`. Holds the `settings` table
  (**global**, workspace-independent: API keys, `active_provider`,
  `recraftory_endpoint`, `active_workspace_path`) and the `workspaces` table
  (`path` PK, `last_opened_at`) backing the recents list. On upgrade from a
  pre-workspace install, the old single-catalog `catalog.db` is renamed to
  `baim.db` in place (`lib.rs::registry_db_path`) — its `settings` carry over
  untouched (no API key re-entry needed), but its old `images`/`generations`
  rows are left in the file, unused (not migrated into any workspace).
- **API key** — stored server-side in the registry's `settings` table per
  provider under key `<provider_id>_api_key` (e.g. `google_api_key`), global
  across every workspace. Written via `set_api_key` (empty string clears it);
  the value never leaves the backend — the frontend only queries presence via
  `has_api_key`. Generation reads the key from the registry:
  `submit_queued`/`do_submit` and `refresh_generation` take both `&RegistryDb`
  (for the key) and `&WorkspaceDb` (for the job).
- **Image files** — saved in the active workspace's folder; generated images
  named `<prediction_id>.jpg`, uploads `<uuid>.png`. Served to the frontend via
  `convertFileSrc(path)` (Tauri asset protocol). The static
  `"$HOME/Pictures/baim-images/**/*"` scope in `tauri.conf.json` is only the
  build-time default; each opened workspace's folder is registered at runtime
  via `app.asset_protocol_scope().allow_directory(dir, true)` (scope is
  additive — a previous workspace's folder is never de-registered). Requires
  `protocol-asset` Cargo feature. CSP must allow `asset:` and
  `http://asset.localhost` for `img-src`.
- **Polling** — `create_prediction` returns immediately with a `pending` record.
  Polling is **query-driven and workspace-scoped**: `generationsQuery(wsPath)`
  (`src/lib/queries.ts`, keyed by the active workspace's path) has a
  `refetchInterval` that fires every 2s while any generation is `pending`, and
  its `queryFn` (`pollAndDrain`) advances each pending row one step via
  `refreshGeneration(id)` then drains the queue via `submitQueued`. The
  interval stops once nothing is pending. In-progress generations render as
  spinner placeholder tiles (`routes/assets/PendingCard.tsx`); the `generate()`
  flow is non-blocking (fire, close panel, free the button) — the finished
  image appears when polling completes.
- **Upload normalization** — uploaded images are converted to PNG data URIs
  client-side (canvas re-encode) via `fileToDataUri()` in `routes/assets/helpers.ts`.
  Images are **saved to the DB and filesystem immediately on pick**
  (not deferred until generation), via `save_uploaded_image`.
- **Path safety** — `delete_image` canonicalizes paths and rejects anything
  outside the active workspace's folder.
- **Rust deps**: `reqwest` (HTTP), `rusqlite` (SQLite), `serde`/`serde_json`,
  `uuid`, `dirs`, `tokio`, `base64`, `async-trait` (provider trait),
  `tauri-plugin-dialog` (folder picker).

### Shared crate (`baim/`)

Cargo workspace member. Contains the `ImageProvider` trait + types and the
`GoogleProvider` implementation. Used by the desktop app (`src-tauri/`).

### Cloud backend

The Cloudflare Workers + D1 + R2 implementation that `RecraftoryProvider`
(`providers/recraftory.rs`) talks to over REST now lives in a separate project,
[`sabi-cloud`](../sabi-cloud) — see its README for architecture and commands.
