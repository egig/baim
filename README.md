# SABI

**S**pecified **A**rtificial **B**atch **I**magery — a desktop app for generating product catalog images using AI.

Batch-generate image variants from a source photo and text prompts. Pick a model provider (Gemini), configure your API key, upload a product shot, write prompts — SABI handles the rest asynchronously.

## Features

- **Upload & manage** source images in a local library
- **Batch generation** — one source image × many prompts, each becomes its own job
- **Async polling** — fire-and-forget; images appear in the grid as they finish
- **Provider abstraction** — Google/Gemini built-in, extensible via the `ImageProvider` trait
- **Cloud mode** — offload generation to a Cloudflare Workers backend (optional)
- **Queue system** — submit jobs from the library view, retry failed ones
- **Database-driven** — SQLite catalog, user-configurable storage directory

## Quick start

```bash
npm install
npx tauri dev
```

Set a Gemini API key in Settings → API Keys, upload an image, write a prompt, and generate.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (port 5173) |
| `npm run build` | Typecheck + Vite build |
| `npm run lint` | oxlint |
| `npx tauri dev` | Full desktop app |
| `npx tauri build` | Production bundle |
| `cargo check -p sabi` | Check shared crate only |

### Prerequisites

- [Rust](https://rustup.rs/) (edition 2021)
- [Node.js](https://nodejs.org/) 20+
- [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/)
- Gemini API key from [Google AI Studio](https://aistudio.google.com/)

## Architecture

```
sabi/
├── src/               React 19 + react-router v8 frontend
├── sabi/              Shared Rust crate (ImageProvider trait + GoogleProvider)
├── src-tauri/         Tauri v2 backend (Rust, SQLite)
└── packages/
    └── sabi-cloud/    Cloudflare Workers (optional cloud mode)
```

The frontend communicates with the Rust backend via Tauri `invoke()`. Image generation goes through the `ImageProvider` trait — providers register themselves in `all_providers()` and are driven from the settings UI. The active provider and API keys are stored in SQLite; the frontend never sees the key value.

## Cloud backend (optional)

A Cloudflare Workers backend in `packages/sabi-cloud/` supports offloading generation. Deploy with:

```bash
cd packages/sabi-cloud
npm run deploy
```

See `TODO-cloud-backend.md` for the roadmap.
