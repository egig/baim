# AGENTS.md

**Last updated**: 2026-07-05

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
  - `/settings` → `routes/setup.tsx` — API key config
- `src/lib/tauri.ts` — single typed bridge to `invoke()` calls. Add new backend
  calls here, not in components.
- `src/root.tsx` — layout shell with sidebar, exports `Button` component.

### Backend (`src-tauri/src/`)

| File | Role |
|---|---|
| `lib.rs` | Tauri setup: opens DB, runs `seed_from_disk()`, registers commands |
| `commands.rs` | Thin `#[tauri::command]` pass-throughs |
| `replicate.rs` | Replicate API logic, image save/delete, `ImageEntry`/`Generation` types |
| `db.rs` | SQLite queries for `images` and `generations` tables |

Commands: `create_prediction`, `refresh_generation`, `get_images`,
`get_generations`, `delete_image`, `save_uploaded_image`.

### Key constraints

- **Database-driven** — SQLite at `~/Pictures/catalog-gen/catalog.db`.
  `get_images` / `get_generations` query the DB, not the filesystem.
  On startup, `seed_from_disk()` idempotently populates the DB from existing
  files on disk (migration path from the old sidecar approach).
- **API key** — stored in `localStorage` under key `replicate_api_key`, passed
  as a param on every invoke. No server-side secret storage.
- **Image files** — saved in `~/Pictures/catalog-gen/` named `<prediction_id>.jpg`.
  Served to the frontend via `convertFileSrc(path)` (Tauri asset protocol).
  Config: `"enable": true`, scope `"$HOME/Pictures/catalog-gen/**/*"` in
  `tauri.conf.json`. Requires `protocol-asset` Cargo feature on the `tauri` crate.
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
  `uuid`, `dirs`, `tokio`, `base64`.
