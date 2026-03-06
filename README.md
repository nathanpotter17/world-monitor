# News Monitor

Layered news dashboard with **embedded local AI**. Pure Rust, zero dependencies.

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

# 3. Ensure llama-server is on PATH (or place all of llama.cpp under models/)
#    Get it from: https://github.com/ggml-org/llama.cpp/releases

# 4. Run
./target/release/world-monitor
# Open http://127.0.0.1:8080
```

The first model found in `models/` is auto-loaded at startup.
You can switch models live from the settings panel.