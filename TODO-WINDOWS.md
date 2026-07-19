# TODO: Windows support fixes

> **For AI agents:** If you are running on Windows (`platform: win32` / PowerShell /
> `cmd`), these tasks are for you. They were identified during a Windows-readiness
> audit done on macOS (2026-07-07), where they could not be built or verified.
> Work through them in order, verify each on this machine, and check items off /
> delete this file when everything passes. When all tasks are done, also remove
> the pointer to this file from `AGENTS.md`.

## Context

Tauri v2 desktop app (React frontend in `src/`, Rust backend in `src-tauri/`).
The audit found the code is largely cross-platform already: no `cfg(unix)` code,
paths built with `PathBuf::join`, CSP already allows `http://asset.localhost`
(the asset-protocol origin on Windows), `icon.ico` exists for bundling, DB goes
to `%APPDATA%` via `dirs::data_dir()`. The items below are what remains.

## Task 1 — Double title bar (cosmetic, high visibility)

`src-tauri/tauri.conf.json` sets `"titleBarStyle": "Overlay"` and
`"hiddenTitle": true`. Both are **macOS-only** and ignored on Windows. With
`"decorations": true`, Windows shows the native title bar **plus** the app's
custom 32px `Titlebar` component (`src/root.tsx`, `data-tauri-drag-region` bar
with the queue/settings buttons) stacked under it.

**Fix:** Add a platform-specific config `src-tauri/tauri.windows.conf.json`
(Tauri merges it on Windows only) that sets `"decorations": false` on the main
window, then add minimize / maximize / close buttons to the `Titlebar` component
(render them only on Windows, e.g. via `platform()` from
`@tauri-apps/plugin-os` or `navigator.userAgent` check), wired to
`getCurrentWindow().minimize() / toggleMaximize() / close()` from
`@tauri-apps/api/window`. Alternative low-effort option: keep native
decorations on Windows and visually merge the custom bar (no drag region
needed there).

**Verify:** `npx tauri dev` — exactly one title bar; window can still be
dragged, minimized, maximized, closed.

## Task 2 — `\\?\` verbatim paths from `canonicalize` (functional risk)

`std::fs::canonicalize` on Windows returns verbatim UNC paths
(`\\?\C:\Users\...`). Used in `src-tauri/src/generation.rs`:

- `set_storage_dir` (~line 268) — the UNC path gets persisted to the DB,
  displayed in the Settings page, used to build image paths handed to
  `convertFileSrc`, and registered with `asset_protocol_scope().allow_directory`.
  Verbatim paths through the asset protocol scope are historically flaky on
  Windows → images may fail to load after the user changes the storage folder.
- `delete_image` (~lines 281–285) — internally consistent (both sides
  canonicalized), but should use the same replacement for uniformity.

**Fix:** Add the `dunce` crate to `src-tauri/Cargo.toml` and replace both
`std::fs::canonicalize` / `.canonicalize()` call sites in `generation.rs` with
`dunce::canonicalize`, which returns plain `C:\...` paths whenever possible.

**Verify:** In the running app, change the storage directory in Settings to a
new folder; the displayed path must have no `\\?\` prefix; generate or upload
an image and confirm the thumbnail renders; delete an image and confirm it
succeeds.

## Task 3 — Default storage dir ignores OneDrive Known Folder Move (minor)

`default_storage_dir()` in `src-tauri/src/generation.rs` (~line 250) uses
`dirs::home_dir().join("Pictures")`. On Windows with OneDrive Known Folder
Move (very common), the real Pictures folder is
`C:\Users\<x>\OneDrive\Pictures`, so the app creates a stray `Pictures` folder
in the profile root.

**Fix:** Use `dirs::picture_dir()` (resolves the actual known folder on every
OS), falling back to the current `home/Pictures` join if it returns `None`.
Keep the fallback so existing installs don't lose their seeded files.

**Verify:** On a fresh profile (or after clearing the `storage_dir` row from
the settings table in `%APPDATA%\com.recraftory.baim\baim.db`),
the app defaults to the real Pictures folder.

## Task 4 — Full Windows build verification

Never yet built on Windows. After Tasks 1–3:

1. `cargo check` from `src-tauri/` (needs Rust MSVC toolchain).
2. `npm run build` (typecheck + Vite).
3. `npx tauri dev` — exercise the full flow: set API key, upload an image,
   generate, watch polling complete, open the image, delete it.
4. `npx tauri build` — confirm NSIS/MSI installers are produced and the
   installed app launches (WebView2 ships with Windows 10/11; NSIS bundles the
   bootstrapper for older machines).
