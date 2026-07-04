# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Tauri desktop app for generating product catalog image variations. The user uploads a product
photo, describes a variation (e.g. "on a wooden table with natural lighting"), and the app sends
the image + prompt to Replicate's `google/nano-banana-2` model, then saves and displays the result.

## Commands

- `npm run dev` — start the Vite dev server (frontend only, port 5173)
- `npm run build` — typecheck (`tsc -b`) and build the frontend to `dist/`
- `npm run lint` — run oxlint
- `npx tauri dev` — run the full desktop app (spawns the Vite dev server via `beforeDevCommand`)
- `npx tauri build` — build the production desktop app bundle
- `cargo check` / `cargo build` (run from `src-tauri/`) — check/build the Rust backend on its own

There is no test suite in this repo currently.

## Architecture

Two halves talk over Tauri's `invoke` bridge:

- **Frontend** (`src/`): React 19 + react-router, Tailwind v4 (via `@tailwindcss/vite`, no config
  file — v4 uses CSS-based config in `src/index.css`). Routes are wired in `src/main.tsx`:
  - `/` — `routes/setup.tsx`: capture and store the Replicate API key
  - `/generate` — `routes/generate.tsx`: upload/drop an image, enter a prompt, trigger generation,
    and see "Recent generations" (pending/succeeded/failed) with re-generate and refresh actions
  - `/gallery` — `routes/gallery.tsx`: browse previously generated images
  - `src/lib/tauri.ts` is the single point of contact with the Rust backend — it wraps every
    `invoke()` call with typed signatures. Add new backend calls here rather than calling
    `invoke` directly from components.

- **Backend** (`src-tauri/src/`): a thin Tauri command layer over a Replicate API client.
  - `commands.rs` — `#[tauri::command]` entry points (`create_prediction`, `refresh_generation`,
    `get_images`, `get_generations`), registered in `lib.rs`'s `invoke_handler!`. Keep this file as
    a thin pass-through to `replicate.rs`.
  - `replicate.rs` — all Replicate API logic. Generation is **async** (Replicate's default mode):
    `create_prediction` POSTs without a `Prefer: wait` header, so it returns as soon as the
    prediction is queued and stores a `pending` generation record (keyed by the Replicate
    prediction id, holding the `urls.get` poll URL). `refresh_generation` polls that URL once and,
    when the prediction reaches a terminal state, downloads the image / records the error and
    advances the record to `succeeded`/`failed`. There is **no** background polling loop — the user
    drives refresh from the UI. Also owns `list_saved_images` and `list_generations`.

### Key design points to preserve

- **No backend-side secret storage.** The Replicate API key lives only in the frontend's
  `localStorage` (`replicate_api_key` in `setup.tsx`/`generate.tsx`) and is passed as a parameter
  on every `create_prediction` / `refresh_generation` invoke call. Don't introduce server-side
  persistence of the key.
- **Generated images are the source of truth for the gallery.** There is no database — images are
  written to `~/Pictures/catalog-gen/` as files, and `get_images` re-derives the gallery list by
  reading that directory each time (sorted by file creation time). Metadata (filename, size,
  created_at) is all derived from the filesystem, not stored separately.
- **Generations are stored as JSON sidecars** in `~/Pictures/catalog-gen/generations/<id>.json`
  (one per attempt: `pending`/`succeeded`/`failed`, with the source image inline as a data URI so
  it can be re-run). They live in a subdirectory so `list_saved_images` — which scans only the
  top-level dir for image files — never picks them up. `list_generations` reads them newest-first.
  A record id is either a Replicate prediction id or a uuid; `refresh_generation` looks records up
  by that id, so ids are validated (alphanumeric + `-`) before being used as a filename.
- **Images are served to the frontend via Tauri's asset protocol**, not by reading bytes over
  `invoke`. The frontend uses `convertFileSrc(path)` to build a displayable URL from an absolute
  path returned by the backend. The allowed path scope is declared in
  `src-tauri/tauri.conf.json` under `app.security.assetProtocol.scope`
  (`$HOME/Pictures/catalog-gen/**`) — if the storage location ever changes, this scope must be
  updated too.
- Uploaded images are normalized to PNG data URIs client-side in `dropzone.tsx` (drawn to a canvas
  and re-encoded) before being sent to the backend, regardless of the original upload format.
