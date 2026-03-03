# World Monitor

Layered world news dashboard with **embedded local AI**. Pure Rust, zero dependencies.

```
  Layer 0: RSS feeds           — always free, no setup
  Layer 1: Local AI analysis   — embedded llama-server + .gguf model
```

## Quick Start

```bash
# 1. Build
cargo build --release

# 2. Put a .gguf model in models/
mkdir models
cp ~/your-model.gguf models/

# 3. Ensure llama-server is on PATH (or use --llama-server)
#    Get it from: https://github.com/ggml-org/llama.cpp/releases

# 4. Run
./target/release/world-monitor
# Open http://127.0.0.1:8080
```

The first model found in `models/` is auto-loaded at startup.
You can switch models live from the settings panel.

## Supported Models

Known models with tuned defaults (GPU layers, context size, temperature):

| Model | Family | Default NGL | Default Ctx |
|-------|--------|-------------|-------------|
| OpenAI GPT-OSS 20B (NEO-CODE2) | gpt-oss | 20 | 4096 |
| DeepResearch 30B A3B | deepseek | 15 | 2048 |
| Qwen3 30B A3B | qwen | 15 | 2048 |
| Qwen2.5 Coder 14B / 7B | qwen | 15-20 | 4096 |
| Llama 3.1 8B Instruct | llama | 20 | 4096 |
| Gemma 3 4B / Gemma 2 9B | gemma | 20-25 | 4096 |

Any unrecognized `.gguf` file will also be discovered with sane defaults (ngl=15, ctx=4096).

## Features

**Scan** — Fetches 22 RSS feeds in parallel across 6 categories.

**Command Bar** — Ask questions about the news:
- "Summarize all headlines"
- "What are the top tech stories?"
- "Any security alerts?"
- "Find connections across categories"

**Drill-down** — Click any headline:
1. Scrapes article + AI summary (if model loaded)
2. AI analysis fallback
3. Raw scraped text (free, no model needed)

**Settings Panel** — Pick model, adjust GPU layers + context, manage budget.

**Model Hot-Swap** — Switch models from the UI without restarting the server.

## Config

```ini
# monitor.conf (optional)
models_dir = models
llama_server = /usr/local/bin/llama-server
llama_port = 8079
model = Qwen3-30B-A3B-Q4_K_M.gguf
ngl = 15
ctx_size = 4096
port = 8080
session_limit = 100000
daily_limit = 500000
per_cat = 8
timeout = 15
```

CLI flags: `--model`, `--models-dir`, `--llama-server`, `--llama-port`, `--ngl`, `--ctx-size`, `--port`, `--session-limit`, `--daily-limit`

## API

| Method | Path           | What                              |
|--------|----------------|-----------------------------------|
| GET    | /              | Dashboard                         |
| POST   | /api/scan      | Fetch RSS feeds                   |
| POST   | /api/ask       | AI query against cached headlines |
| POST   | /api/drill     | Deep-dive a headline              |
| GET    | /api/models    | List discovered models + status   |
| POST   | /api/load      | Load a model (restarts server)    |
| POST   | /api/stop      | Stop llama-server                 |
| GET    | /api/llama     | Llama-server status               |
| GET    | /api/usage     | Token/budget stats                |
| POST   | /api/config    | Update budget limits              |
| GET    | /api/diag      | Feed diagnostics                  |

## Requirements

- Rust stable
- `curl` on PATH
- `llama-server` on PATH (from [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases))
- One or more `.gguf` model files in `models/`