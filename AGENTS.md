# AGENTS.md

**Last updated**: 2026-07-05 — reflects the current `main` branch, which has
diverged from the `CLAUDE.md` (that file describes stale routes and components).

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

Tauri v2 app, two halves over `invoke`:

### Frontend (`src/`)

- React 19 + react-router v8, TypeScript ~6.0
- Tailwind v4 via `@tailwindcss/vite` — **no config file**, CSS-based config
  via `@import "tailwindcss"` in `src/index.css`
- TS quirks: `verbatimModuleSyntax` (use `import type`), `erasableSyntaxOnly`
  (no enums, no namespaces)
- **Routes** (`src/main.tsx`):
  - `/` → `routes/setup.tsx` — dark-themed API key setup (stored in localStorage)
  - `/assets` → `routes/assets.tsx` — light-themed asset library (current main page)
- `src/lib/tauri.ts` — single typed bridge to all `invoke()` calls. Add new
  backend calls here, not in components.

### Backend (`src-tauri/src/`)

- `commands.rs` — thin `#[tauri::command]` pass-throughs to `replicate.rs`
- `replicate.rs` — all Replicate API logic. Started commands:
  `create_prediction`, `refresh_generation`, `get_images`, `get_generations`,
  `delete_image`

### Key constraints

- **No backend-side secret storage** — Replicate API key lives in
  `localStorage` (`replicate_api_key`), passed as a param on every invoke.
- **No database** — images are files in `~/Pictures/catalog-gen/`.
  Generations are JSON sidecars in `~/Pictures/catalog-gen/generations/<id>.json`.
  `get_images` reads the top-level dir (image files only); `get_generations`
  reads the subdirectory (JSON only).
- **Images served via `convertFileSrc(path)`** (asset protocol), not bytes over
  invoke. Scope is `$HOME/Pictures/catalog-gen/**` in `tauri.conf.json`.
- **No background polling** — `create_prediction` returns immediately (async
  mode, no `Prefer: wait`). Frontend drives `refresh_generation` via
  `pollUntilDone()` (45 attempts, 2s interval) in `assets.tsx:91`.
- **Path safety** — `is_safe_id()` limits generation record filenames to
  alphanumeric + `-`. `delete_image` canonicalizes paths and rejects anything
  outside the images directory.
- **Upload normalization** — images are converted to PNG data URIs client-side
  (canvas re-encode) before being sent to the backend.
