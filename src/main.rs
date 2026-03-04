use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Clone, Debug)]
struct CategoryDef {
    name: String,
    icon: String,
    color: String,
}

#[derive(Clone, Debug)]
struct FeedDef {
    name: String,
    url: String,
    category: String,
    enabled: bool,
    timeout: Option<u64>,
}

#[derive(Clone, Debug)]
struct ModelDef {
    filename: String,
    name: String,
    family: String,
    gpu_layers: i32,
    context_size: u32,
    flash_attention: bool,
    temperature: f32,
    top_k: u32,
    top_p: f32,
    repeat_penalty: f32,
}

impl ModelDef {
    fn to_json(&self) -> String {
        format!(
            r#"{{"filename":"{}","path":"{}","name":"{}","family":"{}","ngl":{},"ctx":{},"flash_attn":{},"temp":{:.2},"top_k":{},"top_p":{:.2},"repeat_penalty":{:.2}}}"#,
            jval(&self.filename),
            jval(&self.filename), // path will be resolved at runtime
            jval(&self.name),
            jval(&self.family),
            self.gpu_layers,
            self.context_size,
            self.flash_attention,
            self.temperature,
            self.top_k,
            self.top_p,
            self.repeat_penalty
        )
    }
}

#[derive(Clone, Debug)]
struct Config {
    // Server
    port: u16,
    timeout: u64,
    per_category: usize,

    // Llama
    llama_binary: String,
    llama_port: u16,
    parallel_slots: u32,
    startup_timeout: u64,

    // Limits
    session_limit: u64,
    daily_limit: u64,

    // Defaults
    default_model: String,
    models_dir: String,
    gpu_layers: i32,
    context_size: u32,
    flash_attention: bool,
    temperature: f32,
    top_k: u32,
    top_p: f32,
    repeat_penalty: f32,

    // Runtime state (set after model loads)
    active_model: String,
    active_ngl: i32,
    active_ctx: u32,
    active_flash_attn: bool,
    active_temp: f32,
    active_top_k: u32,
    active_top_p: f32,
    active_repeat_penalty: f32,
}

impl Config {
    fn llama_endpoint(&self) -> String {
        format!("http://127.0.0.1:{}/v1/chat/completions", self.llama_port)
    }

    fn has_ai(&self) -> bool {
        !self.active_model.is_empty()
    }

    fn flash_attn_arg(&self) -> &'static str {
        if self.active_flash_attn { "on" } else { "auto" }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOML PARSING (minimal, no external crate)
// ═══════════════════════════════════════════════════════════════════════════════

struct TomlParser {
    content: String,
}

impl TomlParser {
    fn new(content: String) -> Self {
        Self { content }
    }

    fn get_string(&self, section: &str, key: &str) -> Option<String> {
        let section_header = format!("[{}]", section);
        let content = &self.content;
        
        // Find section
        let section_start = content.find(&section_header)?;
        let section_content = &content[section_start + section_header.len()..];
        
        // Find next section or end
        let section_end = section_content
            .find("\n[")
            .unwrap_or(section_content.len());
        let section_text = &section_content[..section_end];

        self.extract_value(section_text, key)
    }

    fn get_i32(&self, section: &str, key: &str) -> Option<i32> {
        self.get_string(section, key)?.parse().ok()
    }

    fn get_u32(&self, section: &str, key: &str) -> Option<u32> {
        self.get_string(section, key)?.parse().ok()
    }

    fn get_u64(&self, section: &str, key: &str) -> Option<u64> {
        self.get_string(section, key)?.parse().ok()
    }

    fn get_u16(&self, section: &str, key: &str) -> Option<u16> {
        self.get_string(section, key)?.parse().ok()
    }

    fn get_f32(&self, section: &str, key: &str) -> Option<f32> {
        self.get_string(section, key)?.parse().ok()
    }

    fn get_bool(&self, section: &str, key: &str) -> Option<bool> {
        let v = self.get_string(section, key)?;
        match v.to_lowercase().as_str() {
            "true" | "yes" | "on" | "1" => Some(true),
            "false" | "no" | "off" | "0" => Some(false),
            _ => None,
        }
    }

    fn get_usize(&self, section: &str, key: &str) -> Option<usize> {
        self.get_string(section, key)?.parse().ok()
    }

    fn extract_value(&self, text: &str, key: &str) -> Option<String> {
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') || line.is_empty() {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                if k.trim() == key {
                    let v = v.trim();
                    // Remove quotes if present
                    if (v.starts_with('"') && v.ends_with('"'))
                        || (v.starts_with('\'') && v.ends_with('\''))
                    {
                        return Some(v[1..v.len() - 1].to_string());
                    }
                    return Some(v.to_string());
                }
            }
        }
        None
    }

    fn parse_array_of_tables(&self, table_name: &str) -> Vec<String> {
        let mut results = Vec::new();
        let marker = format!("[[{}]]", table_name);
        let mut pos = 0;

        while let Some(start) = self.content[pos..].find(&marker) {
            let abs_start = pos + start + marker.len();
            
            // Find end: next [[ or end of content
            let end = self.content[abs_start..]
                .find("\n[[")
                .map(|e| abs_start + e)
                .unwrap_or(self.content.len());

            results.push(self.content[abs_start..end].to_string());
            pos = end;
        }

        results
    }

    fn parse_categories(&self) -> Vec<CategoryDef> {
        self.parse_array_of_tables("categories")
            .into_iter()
            .filter_map(|block| {
                let name = self.extract_value(&block, "name")?;
                let icon = self.extract_value(&block, "icon").unwrap_or("📰".into());
                let color = self.extract_value(&block, "color").unwrap_or("#4a9eff".into());
                Some(CategoryDef { name, icon, color })
            })
            .collect()
    }

    fn parse_feeds(&self) -> Vec<FeedDef> {
        self.parse_array_of_tables("feeds")
            .into_iter()
            .filter_map(|block| {
                let name = self.extract_value(&block, "name")?;
                let url = self.extract_value(&block, "url")?;
                let category = self.extract_value(&block, "category")?;
                let enabled = self
                    .extract_value(&block, "enabled")
                    .map(|v| v == "true")
                    .unwrap_or(true);
                let timeout = self
                    .extract_value(&block, "timeout")
                    .and_then(|v| v.parse().ok());
                Some(FeedDef { name, url, category, enabled, timeout })
            })
            .collect()
    }

    fn parse_models(&self) -> Vec<ModelDef> {
        self.parse_array_of_tables("models")
            .into_iter()
            .filter_map(|block| {
                let filename = self.extract_value(&block, "filename")?;
                let name = self
                    .extract_value(&block, "name")
                    .unwrap_or_else(|| filename.replace(".gguf", "").replace('-', " "));
                let family = self.extract_value(&block, "family").unwrap_or("unknown".into());
                let gpu_layers = self
                    .extract_value(&block, "gpu_layers")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(15);
                let context_size = self
                    .extract_value(&block, "context_size")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(4096);
                let flash_attention = self
                    .extract_value(&block, "flash_attention")
                    .map(|v| v == "true")
                    .unwrap_or(true);
                let temperature = self
                    .extract_value(&block, "temperature")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0.7);
                let top_k = self
                    .extract_value(&block, "top_k")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(40);
                let top_p = self
                    .extract_value(&block, "top_p")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0.9);
                let repeat_penalty = self
                    .extract_value(&block, "repeat_penalty")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1.1);

                Some(ModelDef {
                    filename,
                    name,
                    family,
                    gpu_layers,
                    context_size,
                    flash_attention,
                    temperature,
                    top_k,
                    top_p,
                    repeat_penalty,
                })
            })
            .collect()
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG LOADING
// ═══════════════════════════════════════════════════════════════════════════════

fn curl_cmd() -> &'static str {
    if cfg!(windows) { "curl.exe" } else { "curl" }
}

fn find_llama_server() -> String {
    let candidates = if cfg!(windows) {
        vec![
            "llama-server.exe",
            "./llama-server.exe",
            "../llama-server.exe",
            "models/llama-server.exe",
            "models\\llama-server.exe",
        ]
    } else {
        vec![
            "llama-server",
            "./llama-server",
            "../llama-server",
            "models/llama-server",
            "/usr/local/bin/llama-server",
            "/usr/bin/llama-server",
        ]
    };

    for p in &candidates {
        if std::path::Path::new(p).exists() {
            return std::path::Path::new(p)
                .canonicalize()
                .map(|c| c.to_string_lossy().to_string())
                .unwrap_or_else(|_| p.to_string());
        }
    }

    if let Ok(o) = Command::new(if cfg!(windows) { "where" } else { "which" })
        .arg("llama-server")
        .output()
    {
        if o.status.success() {
            let p = String::from_utf8_lossy(&o.stdout)
                .trim()
                .lines()
                .next()
                .unwrap_or("llama-server")
                .to_string();
            if !p.is_empty() {
                return p;
            }
        }
    }

    "llama-server".into()
}

fn load_config() -> (Config, Vec<CategoryDef>, Vec<FeedDef>, Vec<ModelDef>) {
    let config_path = env::args()
        .skip_while(|a| a != "--config")
        .nth(1)
        .unwrap_or_else(|| "config.toml".into());

    let content = fs::read_to_string(&config_path).unwrap_or_else(|_| {
        eprintln!("  config: {} not found, using defaults", config_path);
        String::new()
    });

    let parser = TomlParser::new(content);

    // Parse sections
    let categories = parser.parse_categories();
    let feeds = parser.parse_feeds();
    let models = parser.parse_models();

    // Build config
    let mut cfg = Config {
        // Server
        port: parser.get_u16("server", "port").unwrap_or(8080),
        timeout: parser.get_u64("server", "timeout").unwrap_or(15),
        per_category: parser.get_usize("server", "per_category").unwrap_or(5),

        // Llama
        llama_binary: parser
            .get_string("llama", "binary")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(find_llama_server),
        llama_port: parser.get_u16("llama", "port").unwrap_or(8079),
        parallel_slots: parser.get_u32("llama", "parallel_slots").unwrap_or(1),
        startup_timeout: parser.get_u64("llama", "startup_timeout").unwrap_or(120),

        // Limits
        session_limit: parser.get_u64("limits", "session_tokens").unwrap_or(0),
        daily_limit: parser.get_u64("limits", "daily_tokens").unwrap_or(0),

        // Defaults
        default_model: parser.get_string("defaults", "model").unwrap_or_default(),
        models_dir: parser
            .get_string("defaults", "models_dir")
            .unwrap_or_else(|| "models".into()),
        gpu_layers: parser.get_i32("defaults", "gpu_layers").unwrap_or(-1),
        context_size: parser.get_u32("defaults", "context_size").unwrap_or(4096),
        flash_attention: parser.get_bool("defaults", "flash_attention").unwrap_or(true),
        temperature: parser.get_f32("defaults", "temperature").unwrap_or(0.7),
        top_k: parser.get_u32("defaults", "top_k").unwrap_or(40),
        top_p: parser.get_f32("defaults", "top_p").unwrap_or(0.9),
        repeat_penalty: parser.get_f32("defaults", "repeat_penalty").unwrap_or(1.1),

        // Runtime (will be set when model loads)
        active_model: String::new(),
        active_ngl: 0,
        active_ctx: 0,
        active_flash_attn: true,
        active_temp: 0.7,
        active_top_k: 40,
        active_top_p: 0.9,
        active_repeat_penalty: 1.1,
    };

    // CLI overrides
    let args: Vec<String> = env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                args.get(i).and_then(|v| v.parse().ok()).map(|p| cfg.port = p);
            }
            "--model" => {
                i += 1;
                args.get(i).map(|v| cfg.default_model = v.clone());
            }
            "--models-dir" => {
                i += 1;
                args.get(i).map(|v| cfg.models_dir = v.clone());
            }
            "--llama-server" => {
                i += 1;
                args.get(i).map(|v| cfg.llama_binary = v.clone());
            }
            "--llama-port" => {
                i += 1;
                args.get(i).and_then(|v| v.parse().ok()).map(|p| cfg.llama_port = p);
            }
            "--ngl" | "--gpu-layers" => {
                i += 1;
                args.get(i).and_then(|v| v.parse().ok()).map(|n| cfg.gpu_layers = n);
            }
            "--ctx-size" => {
                i += 1;
                args.get(i).and_then(|v| v.parse().ok()).map(|n| cfg.context_size = n);
            }
            "--session-limit" => {
                i += 1;
                args.get(i).and_then(|v| v.parse().ok()).map(|n| cfg.session_limit = n);
            }
            "--daily-limit" => {
                i += 1;
                args.get(i).and_then(|v| v.parse().ok()).map(|n| cfg.daily_limit = n);
            }
            _ => {}
        }
        i += 1;
    }

    // Check models_dir for llama-server if not found
    if !std::path::Path::new(&cfg.llama_binary).exists() {
        let sep = if cfg!(windows) { '\\' } else { '/' };
        let ext = if cfg!(windows) { ".exe" } else { "" };
        let candidate = format!("{}{}llama-server{}", cfg.models_dir, sep, ext);
        if std::path::Path::new(&candidate).exists() {
            cfg.llama_binary = std::path::Path::new(&candidate)
                .canonicalize()
                .map(|c| c.to_string_lossy().to_string())
                .unwrap_or(candidate);
        }
    }

    (cfg, categories, feeds, models)
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERED MODEL — combines config + filesystem discovery
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Clone)]
struct DiscoveredModel {
    filename: String,
    path: String,
    display_name: String,
    family: String,
    gpu_layers: i32,
    context_size: u32,
    flash_attention: bool,
    temperature: f32,
    top_k: u32,
    top_p: f32,
    repeat_penalty: f32,
}

impl DiscoveredModel {
    fn to_json(&self) -> String {
        format!(
            r#"{{"filename":"{}","path":"{}","name":"{}","family":"{}","ngl":{},"ctx":{},"flash_attn":{},"temp":{:.2},"top_k":{},"top_p":{:.2},"repeat_penalty":{:.2}}}"#,
            jval(&self.filename),
            jval(&self.path),
            jval(&self.display_name),
            jval(&self.family),
            self.gpu_layers,
            self.context_size,
            self.flash_attention,
            self.temperature,
            self.top_k,
            self.top_p,
            self.repeat_penalty
        )
    }
}

fn discover_models(dir: &str, known: &[ModelDef], defaults: &Config) -> Vec<DiscoveredModel> {
    let mut models = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => {
            eprintln!("  models dir '{}' not found — create it and place .gguf files inside", dir);
            return models;
        }
    };

    for entry in entries.flatten() {
        let fname = entry.file_name().to_string_lossy().to_string();
        if !fname.ends_with(".gguf") {
            continue;
        }
        let path = entry.path().to_string_lossy().to_string();

        let m = if let Some(k) = known.iter().find(|m| m.filename == fname) {
            DiscoveredModel {
                filename: fname,
                path,
                display_name: k.name.clone(),
                family: k.family.clone(),
                gpu_layers: k.gpu_layers,
                context_size: k.context_size,
                flash_attention: k.flash_attention,
                temperature: k.temperature,
                top_k: k.top_k,
                top_p: k.top_p,
                repeat_penalty: k.repeat_penalty,
            }
        } else {
            let name = fname
                .trim_end_matches(".gguf")
                .replace('-', " ")
                .replace('_', " ");
            DiscoveredModel {
                filename: fname,
                path,
                display_name: name,
                family: "unknown".into(),
                gpu_layers: defaults.gpu_layers,
                context_size: defaults.context_size,
                flash_attention: defaults.flash_attention,
                temperature: defaults.temperature,
                top_k: defaults.top_k,
                top_p: defaults.top_p,
                repeat_penalty: defaults.repeat_penalty,
            }
        };
        models.push(m);
    }

    models.sort_by(|a, b| a.filename.cmp(&b.filename));
    models
}

// ═══════════════════════════════════════════════════════════════════════════════
// LLAMA SERVER MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Clone, PartialEq)]
enum LlamaStatus {
    Stopped,
    Starting,
    Ready,
    Error(String),
}

impl LlamaStatus {
    fn tag(&self) -> &str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Error(_) => "error",
        }
    }
}

struct LlamaServer {
    child: Option<Child>,
    status: LlamaStatus,
    loaded_model: String,
    loaded_ngl: i32,
    loaded_ctx: u32,
    loaded_flash_attn: bool,
    pid: Option<u32>,
}

impl LlamaServer {
    fn new() -> Self {
        LlamaServer {
            child: None,
            status: LlamaStatus::Stopped,
            loaded_model: String::new(),
            loaded_ngl: 0,
            loaded_ctx: 0,
            loaded_flash_attn: false,
            pid: None,
        }
    }

    fn start(&mut self, cfg: &Config, model: &DiscoveredModel) -> Result<(), String> {
        self.stop();
        let ngl = if cfg.active_ngl < 0 { 99 } else { cfg.active_ngl };
        let fa = cfg.flash_attn_arg();
        eprintln!(
            "[llama] Starting {} (ngl={}, ctx={}, fa={})",
            model.display_name, ngl, cfg.active_ctx, fa
        );

        let child = Command::new(&cfg.llama_binary)
            .args([
                "-m", &model.path,
                "--port", &cfg.llama_port.to_string(),
                "-ngl", &ngl.to_string(),
                "-c", &cfg.active_ctx.to_string(),
                "-np", &cfg.parallel_slots.to_string(),
                "--host", "127.0.0.1",
                "--flash-attn", fa,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start llama-server: {e}"))?;

        self.pid = Some(child.id());
        self.child = Some(child);
        self.status = LlamaStatus::Starting;
        self.loaded_model = model.filename.clone();
        self.loaded_ngl = ngl;
        self.loaded_ctx = cfg.active_ctx;
        self.loaded_flash_attn = cfg.active_flash_attn;
        eprintln!("[llama] PID {} — waiting for ready...", self.pid.unwrap_or(0));
        Ok(())
    }

    fn wait_ready(&mut self, port: u16, timeout_secs: u64) -> bool {
        let endpoint = format!("http://127.0.0.1:{}/health", port);
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        std::thread::sleep(Duration::from_millis(500));

        while Instant::now() < deadline {
            if let Some(ref mut child) = self.child {
                match child.try_wait() {
                    Ok(Some(st)) => {
                        let mut errout = String::new();
                        if let Some(ref mut se) = child.stderr {
                            let _ = se.read_to_string(&mut errout);
                        }
                        let detail = if errout.is_empty() {
                            String::new()
                        } else {
                            let lines: Vec<&str> =
                                errout.lines().filter(|l| !l.trim().is_empty()).collect();
                            let tail: Vec<&str> =
                                lines.iter().rev().take(5).rev().cloned().collect();
                            format!("\n{}", tail.join("\n"))
                        };
                        let msg = format!("llama-server exited: {st}{detail}");
                        eprintln!("[llama] {msg}");
                        self.status = LlamaStatus::Error(msg);
                        self.child = None;
                        return false;
                    }
                    Err(e) => {
                        self.status = LlamaStatus::Error(format!("process check: {e}"));
                        return false;
                    }
                    Ok(None) => {}
                }
            } else {
                self.status = LlamaStatus::Error("process gone".into());
                return false;
            }

            if let Ok(out) = Command::new(curl_cmd())
                .args(["-s", "--max-time", "2", &endpoint])
                .output()
            {
                if out.status.success() {
                    let body = String::from_utf8_lossy(&out.stdout);
                    if body.contains("ok") || body.contains("\"status\"") {
                        eprintln!("[llama] Ready!");
                        self.status = LlamaStatus::Ready;
                        return true;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(800));
        }

        let msg = format!("Timeout ({}s) waiting for llama-server", timeout_secs);
        eprintln!("[llama] {msg}");
        self.status = LlamaStatus::Error(msg);
        false
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            eprintln!("[llama] Killing PID {:?}", self.pid);
            let _ = child.kill();
            let _ = child.wait();
        }
        self.status = LlamaStatus::Stopped;
        self.loaded_model.clear();
        self.pid = None;
    }

    fn is_ready(&self) -> bool {
        self.status == LlamaStatus::Ready
    }

    fn status_json(&self) -> String {
        let err = match &self.status {
            LlamaStatus::Error(e) => format!(r#","error":"{}""#, jval(e)),
            _ => String::new(),
        };
        format!(
            r#"{{"status":"{}","model":"{}","ngl":{},"ctx":{},"flash_attn":{},"pid":{}{}}}"#,
            self.status.tag(),
            jval(&self.loaded_model),
            self.loaded_ngl,
            self.loaded_ctx,
            self.loaded_flash_attn,
            self.pid.map_or("null".into(), |p| p.to_string()),
            err
        )
    }
}

impl Drop for LlamaServer {
    fn drop(&mut self) {
        self.stop();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RSS PARSER
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Clone, Debug)]
struct Item {
    title: String,
    link: String,
    desc: String,
    date: String,
    source: String,
    category: String,
}

impl Item {
    fn to_short_line(&self) -> String {
        format!("[{}] {} ({})", self.category, self.title, self.source)
    }
}

fn fetch_one(feed: &FeedDef, timeout: u64) -> (Vec<Item>, String) {
    let actual_timeout = feed.timeout.unwrap_or(timeout);
    let start = Instant::now();
    let out = Command::new(curl_cmd())
        .args([
            "-s", "-L",
            "--max-time", &actual_timeout.to_string(),
            "-H", "User-Agent: Mozilla/5.0 (compatible; WorldMonitor/1.0)",
            "-w", "\n%{http_code}",
            &feed.url,
        ])
        .output();

    let out = match out {
        Ok(o) => o,
        Err(e) => return (vec![], format!("curl error: {e}")),
    };

    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let raw = String::from_utf8_lossy(&out.stdout).to_string();
    
    if raw.is_empty() {
        let d = if stderr.is_empty() {
            format!("exit={}", out.status)
        } else {
            format!("exit={} {}", out.status, stderr.trim())
        };
        return (vec![], format!("empty: {d}"));
    }

    let (body, status) = match raw.rfind('\n') {
        Some(p) => (&raw[..p], raw[p + 1..].trim()),
        None => (raw.as_str(), "???"),
    };
    let elapsed = start.elapsed().as_millis();

    if !out.status.success() {
        return (vec![], format!("curl fail: exit={} http={status} {elapsed}ms", out.status));
    }
    if body.len() < 50 {
        return (vec![], format!("http={status} too small ({} bytes) {elapsed}ms", body.len()));
    }

    let items = parse_feed(body, &feed.name, &feed.category);
    (items.clone(), format!("http={status} {}B {} items {elapsed}ms", body.len(), items.len()))
}

fn parse_feed(xml: &str, source: &str, category: &str) -> Vec<Item> {
    let mut items = Vec::new();
    let is_atom = xml.contains("<entry")
        && (xml.contains("<feed") || xml.contains("xmlns=\"http://www.w3.org/2005/Atom\""));
    let tag = if is_atom { "entry" } else { "item" };

    for block in find_blocks(xml, tag) {
        let title = get_tag_text(&block, "title").unwrap_or_default();
        if title.is_empty() {
            continue;
        }

        let link = if is_atom {
            get_atom_href(&block).or_else(|| get_tag_text(&block, "link"))
        } else {
            get_tag_text(&block, "link").or_else(|| get_tag_text(&block, "guid"))
        }
        .unwrap_or_default();

        let desc = get_tag_text(&block, "description")
            .or_else(|| get_tag_text(&block, "summary"))
            .or_else(|| get_tag_text(&block, "content"))
            .unwrap_or_default();

        let date = get_tag_text(&block, "pubDate")
            .or_else(|| get_tag_text(&block, "published"))
            .or_else(|| get_tag_text(&block, "updated"))
            .or_else(|| get_tag_text(&block, "dc:date"))
            .unwrap_or_default();

        items.push(Item {
            title: strip_html(&title),
            link: link.trim().to_string(),
            desc: trunc(&strip_html(&desc), 200),
            date,
            source: source.into(),
            category: category.into(),
        });
    }
    items
}

fn find_blocks(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut blocks = Vec::new();
    let mut pos = 0;

    while pos < xml.len() {
        let s = match xml[pos..].find(&open) {
            Some(p) => pos + p,
            None => break,
        };
        let after = s + open.len();
        if after < xml.len() {
            let ch = xml.as_bytes()[after];
            if ch != b'>' && ch != b' ' && ch != b'\t' && ch != b'\n' && ch != b'\r' && ch != b'/' {
                pos = after;
                continue;
            }
        }
        match xml[s..].find(&close) {
            Some(e) => {
                blocks.push(xml[s..s + e + close.len()].to_string());
                pos = s + e + close.len();
            }
            None => break,
        }
    }
    blocks
}

fn get_tag_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let s = xml.find(&open)?;
    let after = s + open.len();

    if after < xml.len() {
        let ch = xml.as_bytes()[after];
        if ch != b'>' && ch != b' ' && ch != b'\t' && ch != b'\n' && ch != b'\r' && ch != b'/' {
            return get_tag_text(&xml[after..], tag);
        }
    }

    let tag_end = xml[after..].find('>')? + after + 1;
    if xml[after..tag_end].contains('/') {
        return Some(String::new());
    }

    let ce = xml[tag_end..].find(&close)? + tag_end;
    let mut content = xml[tag_end..ce].trim().to_string();

    if let (Some(cs), Some(cend)) = (content.find("<![CDATA["), content.find("]]>")) {
        content = content[cs + 9..cend].to_string();
    }

    let r = content.trim().to_string();
    if r.is_empty() { None } else { Some(r) }
}

fn get_atom_href(xml: &str) -> Option<String> {
    let mut best: Option<String> = None;
    let mut pos = 0;

    while let Some(s) = xml[pos..].find("<link") {
        let abs = pos + s;
        let end = xml[abs..].find('>')? + abs;
        let tag = &xml[abs..=end];

        if let Some(href) = get_attr(tag, "href") {
            if tag.contains("rel=\"alternate\"") || tag.contains("rel='alternate'") {
                return Some(href);
            }
            if !tag.contains("rel=\"self\"") && !tag.contains("rel='self'") && best.is_none() {
                best = Some(href);
            }
        }
        pos = end + 1;
    }
    best
}

fn get_attr(tag: &str, attr: &str) -> Option<String> {
    for q in ['"', '\''] {
        let pat = format!("{attr}={q}");
        if let Some(s) = tag.find(&pat) {
            let vs = s + pat.len();
            let ve = tag[vs..].find(q)? + vs;
            return Some(tag[vs..ve].to_string());
        }
    }
    None
}

fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;

    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }

    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&#8217;", "\u{2019}")
        .replace("&#8216;", "\u{2018}")
        .replace("&#8220;", "\u{201c}")
        .replace("&#8221;", "\u{201d}")
        .replace("&#8211;", "\u{2013}")
        .replace("&#8212;", "\u{2014}")
        .replace("&nbsp;", " ")
        .replace("&#x27;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn trunc(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.into();
    }
    let mut e = max;
    while e > 0 && !s.is_char_boundary(e) {
        e -= 1;
    }
    format!("{}\u{2026}", &s[..e])
}

fn fetch_all(feeds: &[FeedDef], timeout: u64) -> (Vec<Item>, Vec<(String, String)>) {
    let items: Arc<Mutex<Vec<Item>>> = Arc::new(Mutex::new(Vec::new()));
    let diag: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();

    for feed in feeds.iter().filter(|f| f.enabled) {
        let feed = feed.clone();
        let it2 = Arc::clone(&items);
        let dg2 = Arc::clone(&diag);

        handles.push(std::thread::spawn(move || {
            let (its, msg) = fetch_one(&feed, timeout);
            eprintln!("  {:20} {}", feed.name, msg);
            dg2.lock().unwrap().push((feed.name.clone(), msg));
            it2.lock().unwrap().extend(its);
        }));
    }

    for h in handles {
        let _ = h.join();
    }

    let x = items.lock().unwrap().clone();
    let y = diag.lock().unwrap().clone();
    (x, y)
}

fn scrape_page(url: &str, timeout: u64) -> Option<String> {
    let out = Command::new(curl_cmd())
        .args([
            "-s", "-L",
            "--max-time", &(timeout + 5).to_string(),
            "-H", "User-Agent: Mozilla/5.0 (compatible; WorldMonitor/1.0)",
            url,
        ])
        .output()
        .ok()?;

    if !out.status.success() {
        return None;
    }

    let html = String::from_utf8_lossy(&out.stdout).to_string();
    let mut c = html;

    for tag in &["script", "style", "nav", "footer", "aside", "noscript"] {
        let (o, cl) = (format!("<{}", tag), format!("</{}>", tag));
        while let Some(s) = c.find(&o) {
            match c[s..].find(&cl) {
                Some(e) => c.replace_range(s..s + e + cl.len(), " "),
                None => break,
            }
        }
    }

    let text = strip_html(&c);
    let mut r = String::new();

    for l in text.lines().map(|l| l.trim()).filter(|l| l.len() > 50) {
        if r.len() > 3000 {
            break;
        }
        r.push_str(l);
        r.push('\n');
    }

    if r.len() > 100 { Some(r) } else { None }
}

// ═══════════════════════════════════════════════════════════════════════════════
// USAGE / BUDGET
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Clone)]
struct Usage {
    sess_tok: u64,
    day_tok: u64,
    day_date: String,
    req_count: u64,
    last_scan: Option<u64>,
    n_feeds: usize,
    n_items: usize,
}

impl Usage {
    fn new() -> Self {
        Usage {
            sess_tok: 0,
            day_tok: 0,
            day_date: today(),
            req_count: 0,
            last_scan: None,
            n_feeds: 0,
            n_items: 0,
        }
    }

    fn add(&mut self, tok: u64) {
        let t = today();
        if self.day_date != t {
            self.day_tok = 0;
            self.day_date = t;
        }
        self.sess_tok += tok;
        self.day_tok += tok;
        self.req_count += 1;
    }

    fn check(&self, c: &Config) -> Result<(), String> {
        if !c.has_ai() {
            return Err("No model loaded".into());
        }
        let dt = if self.day_date == today() { self.day_tok } else { 0 };
        if c.session_limit > 0 && self.sess_tok >= c.session_limit {
            return Err("Session limit".into());
        }
        if c.daily_limit > 0 && dt >= c.daily_limit {
            return Err("Daily limit".into());
        }
        Ok(())
    }

    fn json(&self, c: &Config) -> String {
        format!(
            r#"{{"sess_tok":{},"day_tok":{},"day_date":"{}","req_count":{},"session_limit":{},"daily_limit":{},"last_scan":{},"n_feeds":{},"n_items":{},"has_ai":{},"model":"{}"}}"#,
            self.sess_tok,
            self.day_tok,
            self.day_date,
            self.req_count,
            c.session_limit,
            c.daily_limit,
            self.last_scan.map_or("null".into(), |t| t.to_string()),
            self.n_feeds,
            self.n_items,
            c.has_ai(),
            jval(&c.active_model)
        )
    }
}

fn today() -> String {
    let s = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let d = s / 86400;
    let mut y = 1970u64;
    let mut r = d;

    loop {
        let yd = if lp(y) { 366 } else { 365 };
        if r < yd { break; }
        r -= yd;
        y += 1;
    }

    let md = if lp(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut m = 0;
    while m < 12 && r >= md[m] {
        r -= md[m];
        m += 1;
    }

    format!("{y:04}-{:02}-{:02}", m + 1, r + 1)
}

fn now_ts() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn lp(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI CALL
// ═══════════════════════════════════════════════════════════════════════════════

struct AiResp {
    text: String,
    tokens: u64,
    elapsed_ms: u64,
}

fn ai_call(cfg: &Config, system: &str, user: &str) -> Result<AiResp, String> {
    let t0 = Instant::now();
    let body = format!(
        r#"{{"model":"local","messages":[{{"role":"system","content":{}}},{{"role":"user","content":{}}}],"max_tokens":1024,"temperature":{:.2},"top_p":{:.2},"repeat_penalty":{:.2},"stream":false}}"#,
        jesc(system),
        jesc(user),
        cfg.active_temp,
        cfg.active_top_p,
        cfg.active_repeat_penalty
    );

    let endpoint = cfg.llama_endpoint();
    let o = Command::new(curl_cmd())
        .args([
            "-s", "-X", "POST", &endpoint,
            "-H", "content-type: application/json",
            "--max-time", "120",
            "-d", &body,
        ])
        .output()
        .map_err(|e| format!("curl: {e}"))?;

    let elapsed_ms = t0.elapsed().as_millis() as u64;

    if !o.status.success() {
        return Err(format!("curl: {}", String::from_utf8_lossy(&o.stderr)));
    }

    let raw = String::from_utf8_lossy(&o.stdout).to_string();

    if let Some(p) = raw.find("\"error\"") {
        let em = jget(&raw[p..], "message")
            .unwrap_or_else(|| raw[p..p + 100.min(raw.len() - p)].to_string());
        return Err(format!("llama-server: {em}"));
    }

    let text = jget(&raw, "content").unwrap_or_default();
    let pt = jnum(&raw, "prompt_tokens").unwrap_or(0);
    let ct = jnum(&raw, "completion_tokens").unwrap_or(0);
    let tok = if pt + ct > 0 { pt + ct } else { (text.len() as u64) / 4 };

    Ok(AiResp { text, tokens: tok, elapsed_ms })
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSON HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

fn jesc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            _ => o.push(c),
        }
    }
    o.push('"');
    o
}

fn jval(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            _ => o.push(c),
        }
    }
    o
}

fn jget(j: &str, k: &str) -> Option<String> {
    let p = format!("\"{}\"", k);
    let s = j.find(&p)?;
    let r = j[s + p.len()..].trim_start().strip_prefix(':')?.trim_start();

    if !r.starts_with('"') {
        return None;
    }

    let mut ch = r[1..].chars();
    let mut v = String::new();

    loop {
        match ch.next()? {
            '"' => break,
            '\\' => match ch.next()? {
                '"' => v.push('"'),
                '\\' => v.push('\\'),
                'n' => v.push('\n'),
                'r' => v.push('\r'),
                't' => v.push('\t'),
                'u' => {
                    let h: String = ch.by_ref().take(4).collect();
                    u32::from_str_radix(&h, 16).ok().and_then(char::from_u32).map(|c| v.push(c));
                }
                o => {
                    v.push('\\');
                    v.push(o);
                }
            },
            c => v.push(c),
        }
    }

    Some(v)
}

fn jnum(j: &str, k: &str) -> Option<u64> {
    let p = format!("\"{}\"", k);
    let s = j.find(&p)?;
    let r = j[s + p.len()..].trim_start().strip_prefix(':')?.trim_start();
    r.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

fn jfloat(j: &str, k: &str) -> Option<f32> {
    let p = format!("\"{}\"", k);
    let s = j.find(&p)?;
    let r = j[s + p.len()..].trim_start().strip_prefix(':')?.trim_start();
    r.chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect::<String>()
        .parse()
        .ok()
}

fn jbool(j: &str, k: &str) -> Option<bool> {
    let p = format!("\"{}\"", k);
    let s = j.find(&p)?;
    let r = j[s + p.len()..].trim_start().strip_prefix(':')?.trim_start();

    if r.starts_with("true") {
        Some(true)
    } else if r.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

fn jobj(t: &str) -> String {
    if let Some(s) = t.find('{') {
        let mut d = 0;
        let mut ins = false;
        let mut esc = false;

        for (i, c) in t[s..].char_indices() {
            if esc {
                esc = false;
                continue;
            }
            if c == '\\' && ins {
                esc = true;
                continue;
            }
            if c == '"' {
                ins = !ins;
                continue;
            }
            if !ins {
                match c {
                    '{' => d += 1,
                    '}' => {
                        d -= 1;
                        if d == 0 {
                            return t[s..s + i + 1].to_string();
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    "{}".into()
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE + SERVER
// ═══════════════════════════════════════════════════════════════════════════════

struct State {
    cfg: Config,
    usage: Usage,
    items: Vec<Item>,
    diag: Vec<(String, String)>,
    categories: Vec<CategoryDef>,
    feeds: Vec<FeedDef>,
    models: Vec<DiscoveredModel>,
    model_defs: Vec<ModelDef>,
    llama: LlamaServer,
    // RT Monitor state (stored as raw JSON strings from the frontend)
    rt_cameras: String,
    rt_flights: String,
    rt_services: String,
}

type Shared = Arc<Mutex<State>>;

fn main() {
    let (mut cfg, categories, feeds, model_defs) = load_config();
    let discovered_models = discover_models(&cfg.models_dir, &model_defs, &cfg);

    eprintln!("\n  WORLD MONITOR  (TOML config)");
    eprintln!("  {} categories | {} feeds | {} models in {}/",
        categories.len(),
        feeds.iter().filter(|f| f.enabled).count(),
        discovered_models.len(),
        cfg.models_dir
    );

    for m in &discovered_models {
        eprintln!("    {} [{}] ngl={} ctx={} fa={}",
            m.display_name, m.family, m.gpu_layers, m.context_size, m.flash_attention);
    }

    eprintln!("  llama-server: {}", cfg.llama_binary);

    match Command::new(curl_cmd()).arg("--version").output() {
        Ok(o) => eprintln!("  curl: {}",
            String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("ok")),
        Err(e) => {
            eprintln!("  ERROR: {} not found: {}", curl_cmd(), e);
            std::process::exit(1);
        }
    }

    let llama_ok = Command::new(&cfg.llama_binary)
        .arg("--help")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !llama_ok {
        eprintln!("  WARNING: '{}' not found — set llama.binary in config.toml", cfg.llama_binary);
    }

    let addr = format!("127.0.0.1:{}", cfg.port);
    let l = TcpListener::bind(&addr).unwrap_or_else(|e| {
        eprintln!("Bind {addr}: {e}");
        std::process::exit(1);
    });
    eprintln!("  http://{addr}");

    let mut llama = LlamaServer::new();

    // Auto-load model at startup
    if !discovered_models.is_empty() && llama_ok {
        let target = if !cfg.default_model.is_empty() {
            discovered_models.iter().find(|m| m.filename == cfg.default_model)
        } else {
            Some(&discovered_models[0])
        };

        if let Some(m) = target {
            cfg.active_model = m.filename.clone();
            cfg.active_ngl = if cfg.gpu_layers < 0 { m.gpu_layers } else { cfg.gpu_layers };
            cfg.active_ctx = if cfg.context_size == 0 { m.context_size } else { cfg.context_size };
            if cfg.active_ctx == 0 { cfg.active_ctx = 4096; }
            cfg.active_flash_attn = m.flash_attention;
            cfg.active_temp = m.temperature;
            cfg.active_top_k = m.top_k;
            cfg.active_top_p = m.top_p;
            cfg.active_repeat_penalty = m.repeat_penalty;

            if llama.start(&cfg, m).is_ok() {
                llama.wait_ready(cfg.llama_port, cfg.startup_timeout);
            }
        }
    }

    if cfg.active_ctx == 0 {
        cfg.active_ctx = 4096;
    }

    eprintln!();

    let st: Shared = Arc::new(Mutex::new(State {
        cfg,
        usage: Usage::new(),
        items: vec![],
        diag: vec![],
        categories,
        feeds,
        models: discovered_models,
        model_defs,
        llama,
        rt_cameras: "[]".into(),
        rt_flights: "[]".into(),
        rt_services: "[]".into(),
    }));

    for s in l.incoming() {
        if let Ok(s) = s {
            let st = Arc::clone(&st);
            std::thread::spawn(move || serve(s, &st));
        }
    }
}

fn serve(mut s: TcpStream, st: &Shared) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(30)));
    let mut r = BufReader::new(&s);
    let mut req = String::new();

    if r.read_line(&mut req).is_err() {
        return;
    }

    let p: Vec<&str> = req.trim().split_whitespace().collect();
    if p.len() < 2 {
        return;
    }

    let (m, path) = (p[0], p[1]);

    let mut cl = 0usize;
    loop {
        let mut l = String::new();
        if r.read_line(&mut l).is_err() || l.trim().is_empty() {
            break;
        }
        if l.to_lowercase().starts_with("content-length:") {
            l.to_lowercase()
                .trim_start_matches("content-length:")
                .trim()
                .parse()
                .ok()
                .map(|n| cl = n);
        }
    }

    let mut body = vec![0u8; cl];
    if cl > 0 {
        let _ = r.read_exact(&mut body);
    }
    let body = String::from_utf8_lossy(&body).to_string();

    // Camera proxy — special binary response (must be handled before JSON routes)
    if m == "GET" && path.starts_with("/api/rt/cam/proxy") {
        let resp_bytes = do_rt_cam_proxy(st, path);
        let _ = s.write_all(&resp_bytes);
        return;
    }

    let (code, ct, rb) = match (m, path) {
        ("GET", "/") => ("200 OK", "text/html; charset=utf-8", DASH.to_string()),
        ("GET", "/style.css") => ("200 OK", "text/css; charset=utf-8", STYLE.to_string()),
        ("GET", "/script.js") => ("200 OK", "text/javascript; charset=utf-8", SCRIPT.to_string()),
        ("POST", "/api/scan") => ("200 OK", "application/json", do_scan(st)),
        ("POST", "/api/drill") => ("200 OK", "application/json", do_drill(st, &body)),
        ("POST", "/api/ask") => ("200 OK", "application/json", do_ask(st, &body)),
        ("GET", "/api/usage") => {
            let s = st.lock().unwrap();
            ("200 OK", "application/json", s.usage.json(&s.cfg))
        }
        ("GET", "/api/models") => ("200 OK", "application/json", do_models(st)),
        ("GET", "/api/llama") => {
            let s = st.lock().unwrap();
            ("200 OK", "application/json", s.llama.status_json())
        }
        ("POST", "/api/load") => ("200 OK", "application/json", do_load(st, &body)),
        ("POST", "/api/params") => ("200 OK", "application/json", do_params(st, &body)),
        ("POST", "/api/stop") => ("200 OK", "application/json", do_stop(st)),
        ("POST", "/api/config") => ("200 OK", "application/json", do_cfg(st, &body)),
        ("GET", "/api/diag") => ("200 OK", "application/json", do_diag(st)),
        // RT Monitor routes
        ("GET", "/api/rt/state") => ("200 OK", "application/json", do_rt_state(st)),
        ("POST", "/api/rt/cameras") => ("200 OK", "application/json", do_rt_save_cameras(st, &body)),
        ("POST", "/api/rt/flights") => ("200 OK", "application/json", do_rt_save_flights(st, &body)),
        ("POST", "/api/rt/services") => ("200 OK", "application/json", do_rt_save_services(st, &body)),
        ("POST", "/api/rt/check") => ("200 OK", "application/json", do_rt_check(st, &body)),
        ("POST", "/api/rt/flight") => ("200 OK", "application/json", do_rt_flight(st, &body)),
        ("POST", "/api/rt/ask") => ("200 OK", "application/json", do_rt_ask(st, &body)),
        ("POST", "/api/rt/discover") => ("200 OK", "application/json", do_rt_discover(st, &body)),
        ("POST", "/api/drill/ai") => ("200 OK", "application/json", do_drill_ai(st, &body)),
        _ => ("404 Not Found", "text/plain", "Not found".into()),
    };

    let resp = format!(
        "HTTP/1.1 {code}\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{}",
        rb.len(),
        rb
    );
    let _ = s.write_all(resp.as_bytes());
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

fn do_scan(st: &Shared) -> String {
    let (cfg, feeds, categories) = {
        let s = st.lock().unwrap();
        (s.cfg.clone(), s.feeds.clone(), s.categories.clone())
    };

    let enabled_feeds: Vec<FeedDef> = feeds.iter().filter(|f| f.enabled).cloned().collect();
    eprintln!("[scan] Fetching {} feeds...", enabled_feeds.len());

    let (items, diag) = fetch_all(&enabled_feeds, cfg.timeout);
    let total = items.len();
    let ok = diag.iter().filter(|(_, m)| m.contains("items") && !m.contains("0 items")).count();
    eprintln!("[scan] {} items from {}/{} feeds", total, ok, enabled_feeds.len());

    let mut j = String::from(r#"{"headlines":["#);
    let mut first = true;

    for cat in &categories {
        let ci_items: Vec<&Item> = items
            .iter()
            .filter(|i| i.category == cat.name)
            .take(cfg.per_category)
            .collect();

        if ci_items.is_empty() {
            continue;
        }

        if !first {
            j.push(',');
        }
        first = false;

        j.push_str(&format!(
            r#"{{"category":"{}","icon":"{}","items":["#,
            jval(&cat.name),
            jval(&cat.icon)
        ));

        for (ii, it) in ci_items.iter().enumerate() {
            if ii > 0 {
                j.push(',');
            }
            j.push_str(&format!(
                r#"{{"headline":"{}","summary":"{}","source":"{}","link":"{}","date":"{}"}}"#,
                jval(&it.title),
                jval(&it.desc),
                jval(&it.source),
                jval(&it.link),
                jval(&it.date)
            ));
        }
        j.push_str("]}");
    }

    j.push_str(&format!(
        r#"],"feeds":{},"items":{},"ok":{}}}"#,
        enabled_feeds.len(),
        total,
        ok
    ));

    let mut s = st.lock().unwrap();
    s.usage.last_scan = Some(now_ts());
    s.usage.n_feeds = ok;
    s.usage.n_items = total;
    s.items = items;
    s.diag = diag;
    j
}

fn do_drill(st: &Shared, body: &str) -> String {
    let topic = jget(body, "topic").unwrap_or_default();
    let link = jget(body, "link").unwrap_or_default();

    if topic.is_empty() {
        return r#"{"error":"no topic"}"#.into();
    }

    let cfg = st.lock().unwrap().cfg.clone();
    let t0 = Instant::now();

    // Always curl-first: scrape the page and return raw text
    if !link.is_empty() {
        eprintln!("[drill] curling {link}");
        if let Some(text) = scrape_page(&link, cfg.timeout) {
            let elapsed = t0.elapsed().as_millis() as u64;
            return format!(
                r#"{{"drill":{{"title":"{}","detail":"{}","sources":["scraped"],"related":[]}},"scraped_text":"{}","tokens":0,"elapsed_ms":{},"mode":"page"}}"#,
                jval(&topic),
                jval(&trunc(&text, 4000)),
                jval(&trunc(&text, 8000)),
                elapsed
            );
        }
    }

    // No link or scrape failed — return just the topic
    let elapsed = t0.elapsed().as_millis() as u64;
    format!(
        r#"{{"drill":{{"title":"{}","detail":"Could not fetch article content. Use AI Summary for analysis based on the headline.","sources":[],"related":[]}},"scraped_text":"","tokens":0,"elapsed_ms":{},"mode":"none"}}"#,
        jval(&topic),
        elapsed
    )
}

/// Separate endpoint for AI summary — called on-demand from the drill overlay
fn do_drill_ai(st: &Shared, body: &str) -> String {
    let topic = jget(body, "topic").unwrap_or_default();
    let text = jget(body, "text").unwrap_or_default();

    let (cfg, can_ai, ready) = {
        let s = st.lock().unwrap();
        (s.cfg.clone(), s.usage.check(&s.cfg).is_ok(), s.llama.is_ready())
    };

    if !can_ai || !ready {
        let why = if !cfg.has_ai() {
            "No model loaded. Select one in settings."
        } else if !ready {
            "Model still loading..."
        } else {
            "Token budget exhausted."
        };
        return format!(r#"{{"error":"{}"}}"#, jval(why));
    }

    let prompt = if text.is_empty() {
        format!(
            "Provide a concise analysis of this news topic: \"{topic}\".\n\n\
             Return JSON only:\n{{\"title\":\"...\",\"summary\":\"2-3 paragraph analysis\",\"key_points\":[\"...\"],\"related\":[\"...\",\"...\"]}}"
        )
    } else {
        let max_chars = ((cfg.active_ctx as usize).saturating_sub(1500)) * 4;
        let text = trunc(&text, max_chars);
        format!(
            "Summarize this article titled \"{topic}\":\n\n{text}\n\n\
             Return JSON only:\n{{\"title\":\"...\",\"summary\":\"2-3 paragraph analysis\",\"key_points\":[\"...\"],\"related\":[\"...\",\"...\"]}}"
        )
    };

    match ai_call(&cfg, "Concise news analyst. JSON only, no markdown fences.", &prompt) {
        Ok(r) => {
            st.lock().unwrap().usage.add(r.tokens);
            format!(
                r#"{{"ai":{},"tokens":{},"elapsed_ms":{}}}"#,
                jobj(&r.text),
                r.tokens,
                r.elapsed_ms
            )
        }
        Err(e) => {
            format!(r#"{{"error":"{}"}}"#, jval(&e))
        }
    }
}

fn do_ask(st: &Shared, body: &str) -> String {
    let query = jget(body, "query").unwrap_or_default();
    if query.is_empty() {
        return r#"{"error":"No query"}"#.into();
    }

    let (cfg, items, categories, can_ai, ready) = {
        let s = st.lock().unwrap();
        (
            s.cfg.clone(),
            s.items.clone(),
            s.categories.clone(),
            s.usage.check(&s.cfg).is_ok(),
            s.llama.is_ready(),
        )
    };

    if !can_ai || !ready {
        let why = if !cfg.has_ai() {
            "No model loaded. Select one in settings."
        } else if !ready {
            "Model still loading..."
        } else {
            "Token budget exhausted."
        };
        return format!(r#"{{"answer":"{}","tokens":0}}"#, jval(why));
    }

    if items.is_empty() {
        return r#"{"answer":"No feeds loaded. Click Scan first.","tokens":0}"#.into();
    }

    let cat_filt = jget(body, "category").unwrap_or_default();
    let filtered: Vec<&Item> = if cat_filt.is_empty() {
        items.iter().collect()
    } else {
        items
            .iter()
            .filter(|i| i.category.to_lowercase().contains(&cat_filt.to_lowercase()))
            .collect()
    };

    let max_context_chars = ((cfg.active_ctx as usize).saturating_sub(1500)) * 4;
    let mut context = String::new();
    let mut n_ctx = 0usize;

    for (i, item) in filtered.iter().enumerate() {
        let line = format!("{}. {}\n", i + 1, item.to_short_line());
        if context.len() + line.len() > max_context_chars {
            break;
        }
        context.push_str(&line);
        n_ctx = i + 1;
    }

    let cat_names: Vec<&str> = categories.iter().map(|c| c.name.as_str()).collect();
    let system = format!(
        "You are a news analyst. You have {} headlines from feeds ({}).\
         Answer based ONLY on the headlines. Be concise. Cite sources. Plain text only.",
        n_ctx,
        cat_names.join(", ")
    );
    let prompt = format!("Headlines:\n\n{context}\n\nQuestion: {query}");

    eprintln!("[ask] {} ({}/{} items, ~{}ch)", query, n_ctx, filtered.len(), context.len());

    match ai_call(&cfg, &system, &prompt) {
        Ok(r) => {
            st.lock().unwrap().usage.add(r.tokens);
            eprintln!("[ask] {} tok {:.1}s", r.tokens, r.elapsed_ms as f64 / 1000.0);
            format!(
                r#"{{"answer":"{}","tokens":{},"elapsed_ms":{}}}"#,
                jval(&r.text),
                r.tokens,
                r.elapsed_ms
            )
        }
        Err(e) => {
            eprintln!("[ask] err: {e}");
            format!(r#"{{"answer":"Error: {}","tokens":0,"elapsed_ms":0}}"#, jval(&e))
        }
    }
}

fn do_models(st: &Shared) -> String {
    let s = st.lock().unwrap();
    let mut j = String::from(r#"{"models":["#);

    for (i, m) in s.models.iter().enumerate() {
        if i > 0 {
            j.push(',');
        }
        j.push_str(&m.to_json());
    }

    j.push_str(&format!(
        r#"],"active":"{}","params":{{"ngl":{},"ctx":{},"flash_attn":{},"temp":{:.2},"top_k":{},"top_p":{:.2},"repeat_penalty":{:.2}}},"llama":{}}}"#,
        jval(&s.cfg.active_model),
        s.cfg.active_ngl,
        s.cfg.active_ctx,
        s.cfg.active_flash_attn,
        s.cfg.active_temp,
        s.cfg.active_top_k,
        s.cfg.active_top_p,
        s.cfg.active_repeat_penalty,
        s.llama.status_json()
    ));
    j
}

fn do_load(st: &Shared, body: &str) -> String {
    let filename = jget(body, "model").unwrap_or_default();
    if filename.is_empty() {
        return r#"{"error":"no model specified"}"#.into();
    }

    let (model, mut cfg) = {
        let s = st.lock().unwrap();
        let model = match s.models.iter().find(|m| m.filename == filename) {
            Some(m) => m.clone(),
            None => return format!(r#"{{"error":"model '{}' not found"}}"#, jval(&filename)),
        };
        (model, s.cfg.clone())
    };

    cfg.active_model = filename;
    cfg.active_ngl = jnum(body, "ngl").map(|n| n as i32).unwrap_or(model.gpu_layers);
    cfg.active_ctx = jnum(body, "ctx").map(|n| n as u32).unwrap_or(model.context_size);
    if cfg.active_ctx < 2048 {
        cfg.active_ctx = 2048;
    }
    cfg.active_flash_attn = jbool(body, "flash_attn").unwrap_or(model.flash_attention);
    cfg.active_temp = jfloat(body, "temp").unwrap_or(model.temperature);
    cfg.active_top_k = jnum(body, "top_k").map(|n| n as u32).unwrap_or(model.top_k);
    cfg.active_top_p = jfloat(body, "top_p").unwrap_or(model.top_p);
    cfg.active_repeat_penalty = jfloat(body, "repeat_penalty").unwrap_or(model.repeat_penalty);

    let mut llama = LlamaServer::new();
    st.lock().unwrap().llama.stop();

    if let Err(e) = llama.start(&cfg, &model) {
        let mut s = st.lock().unwrap();
        s.cfg.active_model.clear();
        return format!(r#"{{"error":"{}"}}"#, jval(&e));
    }

    let port = cfg.llama_port;
    let timeout = cfg.startup_timeout;
    let ok = llama.wait_ready(port, timeout);
    let sj = llama.status_json();

    {
        let mut s = st.lock().unwrap();
        s.llama = llama;
        s.cfg = cfg;
    }

    format!(r#"{{"ok":{},"llama":{}}}"#, ok, sj)
}

fn do_stop(st: &Shared) -> String {
    let mut s = st.lock().unwrap();
    s.llama.stop();
    s.cfg.active_model.clear();
    r#"{"ok":true,"status":"stopped"}"#.into()
}

fn do_params(st: &Shared, body: &str) -> String {
    let mut s = st.lock().unwrap();
    jfloat(body, "temp").map(|v| s.cfg.active_temp = v);
    jnum(body, "top_k").map(|v| s.cfg.active_top_k = v as u32);
    jfloat(body, "top_p").map(|v| s.cfg.active_top_p = v);
    jfloat(body, "repeat_penalty").map(|v| s.cfg.active_repeat_penalty = v);

    eprintln!(
        "[params] temp={:.2} top_k={} top_p={:.2} rp={:.2}",
        s.cfg.active_temp, s.cfg.active_top_k, s.cfg.active_top_p, s.cfg.active_repeat_penalty
    );

    format!(
        r#"{{"ok":true,"temp":{:.2},"top_k":{},"top_p":{:.2},"repeat_penalty":{:.2}}}"#,
        s.cfg.active_temp,
        s.cfg.active_top_k,
        s.cfg.active_top_p,
        s.cfg.active_repeat_penalty
    )
}

fn do_cfg(st: &Shared, body: &str) -> String {
    let mut s = st.lock().unwrap();
    jnum(body, "session_limit").map(|v| s.cfg.session_limit = v);
    jnum(body, "daily_limit").map(|v| s.cfg.daily_limit = v);
    jnum(body, "per_cat").map(|v| s.cfg.per_category = v as usize);
    let uj = s.usage.json(&s.cfg);
    format!(r#"{{"usage":{}}}"#, uj)
}

fn do_diag(st: &Shared) -> String {
    let s = st.lock().unwrap();
    let mut j = String::from("[");

    for (i, (name, msg)) in s.diag.iter().enumerate() {
        if i > 0 {
            j.push(',');
        }
        j.push_str(&format!(
            r#"{{"feed":"{}","status":"{}"}}"#,
            jval(name),
            jval(msg)
        ));
    }

    j.push(']');
    j
}

// ═══════════════════════════════════════════════════════════════════════════════
// RT MONITOR ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

fn do_rt_state(st: &Shared) -> String {
    let s = st.lock().unwrap();
    format!(
        r#"{{"cameras":{},"flights":{},"services":{}}}"#,
        s.rt_cameras,
        s.rt_flights,
        s.rt_services
    )
}

fn do_rt_save_cameras(st: &Shared, body: &str) -> String {
    // Extract the cameras array from the body
    if let Some(start) = body.find("[") {
        if let Some(end) = body.rfind("]") {
            let arr = &body[start..=end];
            st.lock().unwrap().rt_cameras = arr.to_string();
            return r#"{"ok":true}"#.into();
        }
    }
    r#"{"ok":true}"#.into()
}

fn do_rt_save_flights(st: &Shared, body: &str) -> String {
    if let Some(start) = body.find("[") {
        if let Some(end) = body.rfind("]") {
            let arr = &body[start..=end];
            st.lock().unwrap().rt_flights = arr.to_string();
            return r#"{"ok":true}"#.into();
        }
    }
    r#"{"ok":true}"#.into()
}

fn do_rt_save_services(st: &Shared, body: &str) -> String {
    if let Some(start) = body.find("[") {
        if let Some(end) = body.rfind("]") {
            let arr = &body[start..=end];
            st.lock().unwrap().rt_services = arr.to_string();
            return r#"{"ok":true}"#.into();
        }
    }
    r#"{"ok":true}"#.into()
}

fn do_rt_check(st: &Shared, body: &str) -> String {
    let url = jget(body, "url").unwrap_or_default();
    let method = jget(body, "method").unwrap_or("http".into());

    if url.is_empty() {
        return r#"{"error":"no url"}"#.into();
    }

    let cfg = st.lock().unwrap().cfg.clone();
    let t0 = Instant::now();

    // Detect if this is likely a camera/image URL
    let is_image_url = {
        let lu = url.to_lowercase();
        lu.ends_with(".jpg") || lu.ends_with(".jpeg") || lu.ends_with(".png")
            || lu.ends_with(".gif") || lu.contains("/cctv/") || lu.contains("/image")
            || lu.contains("/snapshot") || lu.contains("/mjpg/") || lu.contains("axis-cgi")
            || lu.contains("cctvimage") || lu.contains("maphandler") || lu.contains("viewimage")
            || lu.contains("flowimages") || lu.contains("roadcams") || lu.contains("travelercam")
    };

    match method.as_str() {
        "http" => {
            let actual_url = if url.starts_with("http://") || url.starts_with("https://") {
                url.clone()
            } else {
                format!("http://{}", url)
            };

            // Derive Referer from URL origin
            let referer = {
                if let Some(idx) = actual_url.find("://") {
                    let after = &actual_url[idx + 3..];
                    let host_end = after.find('/').unwrap_or(after.len());
                    format!("{}/", &actual_url[..idx + 3 + host_end])
                } else { String::new() }
            };

            let out = Command::new(curl_cmd())
                .args([
                    "-s", "-L",
                    "--max-time", &cfg.timeout.to_string(),
                    "-o", "/dev/null",
                    "-w", "%{http_code}\t%{content_type}\t%{num_redirects}\t%{url_effective}\t%{size_download}",
                    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "-H", &format!("Referer: {}", referer),
                    "-H", "Accept: image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    &actual_url,
                ])
                .output();

            let latency = t0.elapsed().as_millis() as u64;

            match out {
                Ok(o) => {
                    let raw = String::from_utf8_lossy(&o.stdout).to_string();
                    let parts: Vec<&str> = raw.split('\t').collect();
                    let code_num: u32 = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
                    let content_type = parts.get(1).unwrap_or(&"").to_string();
                    let redirects: u32 = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
                    let effective_url = parts.get(3).unwrap_or(&"").to_string();
                    let size_str = parts.get(4).unwrap_or(&"0").trim().to_string();
                    let size_bytes: u64 = size_str.parse().unwrap_or(0);

                    let http_ok = code_num >= 200 && code_num < 300;
                    let ct_lower = content_type.to_lowercase();
                    let is_image_ct = ct_lower.contains("image/") || ct_lower.contains("multipart/x-mixed-replace");

                    // Image validation: real images are >4KB with image Content-Type
                    let image_valid = is_image_url && http_ok && is_image_ct && size_bytes > 4096;
                    let up = if is_image_url { http_ok } else { code_num >= 200 && code_num < 500 };
                    let detail = if is_image_url && http_ok && image_valid {
                        format!("HTTP {} — valid image ({}B)", code_num, size_bytes)
                    } else if is_image_url && http_ok && !is_image_ct {
                        format!("HTTP {} — not image ({})", code_num, content_type)
                    } else if is_image_url && http_ok && size_bytes <= 4096 {
                        format!("HTTP {} — too small ({}B placeholder?)", code_num, size_bytes)
                    } else {
                        format!("HTTP {}", code_num)
                    };

                    let server = if http_ok {
                        Command::new(curl_cmd())
                            .args(["-s", "-I", "-L", "--max-time", "4",
                                "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                                "-H", &format!("Referer: {}", referer),
                                &actual_url])
                            .output().ok()
                            .map(|ho| {
                                String::from_utf8_lossy(&ho.stdout).lines()
                                    .find(|l| l.to_lowercase().starts_with("server:"))
                                    .map(|l| l.splitn(2, ':').nth(1).unwrap_or("").trim().to_string())
                                    .unwrap_or_default()
                            }).unwrap_or_default()
                    } else { String::new() };

                    format!(
                        r#"{{"up":{},"latency_ms":{},"http_code":{},"content_type":"{}","detail":"{}","server":"{}","redirects":{},"final_url":"{}","size":"{}B","image_valid":{}}}"#,
                        up, latency, code_num, jval(&content_type), jval(&detail), jval(&server),
                        redirects, jval(&effective_url), size_bytes, image_valid
                    )
                }
                Err(e) => format!(r#"{{"up":false,"latency_ms":{},"detail":"{}","image_valid":false}}"#, latency, jval(&format!("curl: {e}")))
            }
        }
        "ping" => {
            let host = url.split(':').next().unwrap_or(&url);

            // Try ICMP ping first
            let count_flag = if cfg!(windows) { "-n" } else { "-c" };
            let timeout_flag = if cfg!(windows) { "-w" } else { "-W" };
            // Use -W with seconds on Linux
            let out = Command::new("ping")
                .args([count_flag, "1", timeout_flag, "3", host])
                .output();

            let latency = t0.elapsed().as_millis() as u64;

            match out {
                Ok(o) if o.status.success() => {
                    let stdout = String::from_utf8_lossy(&o.stdout);
                    let detail = stdout
                        .split("time=")
                        .nth(1)
                        .and_then(|s| s.split_whitespace().next())
                        .unwrap_or("ok")
                        .to_string();
                    format!(
                        r#"{{"up":true,"latency_ms":{},"detail":"ping {}"}}"#,
                        latency, jval(&detail)
                    )
                }
                _ => {
                    // ICMP failed (common in containers) — fall back to TCP connect via curl
                    let t1 = std::time::Instant::now();
                    let tcp_url = if host.contains('.') && !host.starts_with("http") {
                        format!("https://{}", host)
                    } else {
                        host.to_string()
                    };
                    let tcp_out = Command::new(curl_cmd())
                        .args([
                            "-s", "-o", "/dev/null",
                            "--max-time", "4",
                            "-w", "%{http_code}",
                            &tcp_url,
                        ])
                        .output();
                    let tcp_latency = t1.elapsed().as_millis() as u64;

                    match tcp_out {
                        Ok(to) if to.status.success() => {
                            let code = String::from_utf8_lossy(&to.stdout).trim().to_string();
                            let code_num: u32 = code.parse().unwrap_or(0);
                            let up = code_num > 0 && code_num < 500;
                            format!(
                                r#"{{"up":{},"latency_ms":{},"detail":"TCP connect HTTP {} (ICMP unavailable)"}}"#,
                                up, tcp_latency, code
                            )
                        }
                        _ => {
                            format!(
                                r#"{{"up":false,"latency_ms":{},"detail":"ICMP and TCP both failed"}}"#,
                                latency
                            )
                        }
                    }
                }
            }
        }
        "tcp" => {
            // Parse host:port
            let parts: Vec<&str> = url.rsplitn(2, ':').collect();
            let (port_str, host) = if parts.len() == 2 {
                (parts[0], parts[1])
            } else {
                ("80", url.as_str())
            };
            let port: u16 = port_str.parse().unwrap_or(80);

            let addr = format!("{}:{}", host, port);
            let result = std::net::TcpStream::connect_timeout(
                &addr.parse().unwrap_or_else(|_| {
                    // Try DNS resolution
                    use std::net::ToSocketAddrs;
                    addr.to_socket_addrs()
                        .ok()
                        .and_then(|mut addrs| addrs.next())
                        .unwrap_or_else(|| "0.0.0.0:0".parse().unwrap())
                }),
                Duration::from_secs(cfg.timeout),
            );

            let latency = t0.elapsed().as_millis() as u64;

            match result {
                Ok(_) => {
                    format!(
                        r#"{{"up":true,"latency_ms":{},"detail":"TCP connect OK (port {})"}}"#,
                        latency, port
                    )
                }
                Err(e) => {
                    format!(
                        r#"{{"up":false,"latency_ms":{},"detail":"{}"}}"#,
                        latency,
                        jval(&format!("TCP: {e}"))
                    )
                }
            }
        }
        _ => r#"{"error":"unknown method"}"#.into(),
    }
}

fn do_rt_flight(st: &Shared, body: &str) -> String {
    let callsign = jget(body, "callsign").unwrap_or_default();
    let source = jget(body, "source").unwrap_or("adsb".into());

    if callsign.is_empty() {
        return r#"{"error":"no callsign"}"#.into();
    }

    let cfg = st.lock().unwrap().cfg.clone();

    match source.as_str() {
        "opensky" => {
            // OpenSky Network: try by callsign first (most common use case)
            let callsign_padded = format!("{:<8}", callsign); // OpenSky pads to 8 chars
            let url = "https://opensky-network.org/api/states/all";

            eprintln!("[rt-flight] OpenSky lookup: {}", callsign);

            let out = Command::new(curl_cmd())
                .args([
                    "-s", "--max-time", &(cfg.timeout + 10).to_string(),
                    "-H", "User-Agent: WorldMonitor/1.0",
                    &url,
                ])
                .output();

            match out {
                Ok(o) if o.status.success() => {
                    let raw = String::from_utf8_lossy(&o.stdout).to_string();

                    if raw.contains("\"states\":null") || !raw.contains("\"states\"") {
                        return format!(
                            r#"{{"status":"not_found","info":"OpenSky returned no active flights","source":"opensky"}}"#
                        );
                    }

                    // Parse OpenSky states array: each state is [icao24, callsign, origin, time, last_contact,
                    //   lng, lat, baro_alt, on_ground, velocity, heading, vertical_rate, sensors,
                    //   geo_alt, squawk, spi, position_source, ...]
                    // Search for our callsign in the raw data
                    let cs_lower = callsign.to_lowercase();
                    let cs_trimmed = cs_lower.trim();

                    // Find the states array
                    if let Some(states_start) = raw.find("\"states\":") {
                        let states_area = &raw[states_start..];
                        // Look for our callsign in the states
                        let search_patterns = [
                            format!("\"{}\"", callsign.to_uppercase()),
                            format!("\"{}\"", callsign_padded.to_uppercase()),
                            format!("\"{}\"", cs_trimmed),
                            format!("\"{} \"", cs_trimmed),
                        ];

                        let mut found = false;
                        for pat in &search_patterns {
                            if let Some(cs_pos) = states_area.find(pat.as_str()) {
                                found = true;
                                // Walk backward to find the start of this state array "["
                                let before = &states_area[..cs_pos];
                                if let Some(arr_start) = before.rfind('[') {
                                    // Walk forward to find end "]"
                                    if let Some(arr_end) = states_area[arr_start..].find(']') {
                                        let state_str = &states_area[arr_start..arr_start + arr_end + 1];
                                        // Parse the array manually — extract comma-separated values
                                        // OpenSky state vector indices:
                                        // 0:icao24, 1:callsign, 2:origin_country, 3:time_position, 4:last_contact,
                                        // 5:longitude, 6:latitude, 7:baro_altitude, 8:on_ground, 9:velocity,
                                        // 10:true_track, 11:vertical_rate, 12:sensors, 13:geo_altitude,
                                        // 14:squawk, 15:spi, 16:position_source, 17:category
                                        let inner = &state_str[1..state_str.len() - 1];
                                        let fields = split_json_array(inner);

                                        let icao = clean_json_str(fields.get(0).unwrap_or(&""));
                                        let cs = clean_json_str(fields.get(1).unwrap_or(&"")).trim().to_string();
                                        let origin = clean_json_str(fields.get(2).unwrap_or(&""));
                                        let time_position: i64 = fields.get(3).and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                                        let last_contact: i64 = fields.get(4).and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                                        let lng: f64 = fields.get(5).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
                                        let lat: f64 = fields.get(6).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
                                        let baro_alt: f64 = fields.get(7).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
                                        let on_ground = fields.get(8).map(|s| s.trim() == "true").unwrap_or(false);
                                        let velocity: f64 = fields.get(9).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
                                        let heading: f64 = fields.get(10).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
                                        let vert_rate: f64 = fields.get(11).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
                                        let geo_alt: f64 = fields.get(13).and_then(|s| s.trim().parse().ok()).unwrap_or(baro_alt);
                                        let squawk = clean_json_str(fields.get(14).unwrap_or(&""));
                                        let spi = fields.get(15).map(|s| s.trim() == "true").unwrap_or(false);
                                        let pos_source: u32 = fields.get(16).and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                                        let category: u32 = fields.get(17).and_then(|s| s.trim().parse().ok()).unwrap_or(0);

                                        let display_alt = if geo_alt > 0.0 { geo_alt } else { baro_alt };
                                        let position = if lat != 0.0 || lng != 0.0 {
                                            format!("{:.4}, {:.4}", lat, lng)
                                        } else {
                                            "unknown".into()
                                        };

                                        // Map position_source to string
                                        let pos_source_str = match pos_source {
                                            0 => "ADS-B",
                                            1 => "ASTERIX",
                                            2 => "MLAT",
                                            3 => "FLARM",
                                            _ => "Unknown",
                                        };

                                        // Map category to string
                                        let cat_str = match category {
                                            0 => "",
                                            1 => "No category info",
                                            2 => "Light (<15500 lbs)",
                                            3 => "Small (15500-75000 lbs)",
                                            4 => "Large (75000-300000 lbs)",
                                            5 => "High Vortex Large (B-757)",
                                            6 => "Heavy (>300000 lbs)",
                                            7 => "High Performance (>5g, >400kts)",
                                            8 => "Rotorcraft",
                                            9 => "Glider/Sailplane",
                                            10 => "Lighter-than-air",
                                            11 => "Parachutist/Skydiver",
                                            12 => "Ultralight/Paraglider",
                                            14 => "UAV",
                                            15 => "Space/Trans-atmospheric",
                                            16 => "Emergency Vehicle",
                                            17 => "Service Vehicle",
                                            _ => "",
                                        };

                                        eprintln!(
                                            "[rt-flight] Found {} ({}): {},{} alt={:.0}m spd={:.0}m/s hdg={:.0} sqk={} cat={} src={}",
                                            cs, origin, lat, lng, display_alt, velocity, heading, squawk, cat_str, pos_source_str
                                        );

                                        // Derive airline from ICAO callsign prefix (first 3 letters)
                                        let airline = icao_airline_name(&cs);

                                        // Look up route via cache file, then OpenSky routes API if not cached
                                        let (departure, destination) = lookup_flight_route(&cs);

                                        return format!(
                                            r#"{{"status":"tracked","info":"Live via OpenSky — {} ({})","source":"opensky","position":"{}","latitude":{},"longitude":{},"altitude":{:.0},"baro_altitude":{:.0},"geo_altitude":{:.0},"velocity":{:.1},"heading":{:.0},"vertical_rate":{:.1},"on_ground":{},"origin_country":"{}","icao":"{}","squawk":"{}","spi":{},"position_source":"{}","category":"{}","category_id":{},"time_position":{},"last_contact":{},"departure":"{}","destination":"{}","airline":"{}"}}"#,
                                            jval(&cs), jval(&origin), jval(&position),
                                            lat, lng,
                                            display_alt, baro_alt, geo_alt,
                                            velocity, heading, vert_rate, on_ground,
                                            jval(&origin), jval(&icao),
                                            jval(&squawk), spi,
                                            jval(pos_source_str), jval(cat_str), category,
                                            time_position, last_contact,
                                            jval(&departure), jval(&destination),
                                            jval(&airline)
                                        );
                                    }
                                }
                                break;
                            }
                        }

                        if !found {
                            return format!(
                                r#"{{"status":"not_found","info":"Callsign {} not in current OpenSky data ({} active flights)","source":"opensky"}}"#,
                                jval(&callsign),
                                raw.matches("[\"").count()
                            );
                        }
                    }

                    format!(
                        r#"{{"status":"error","info":"Could not parse OpenSky response","source":"opensky"}}"#
                    )
                }
                Ok(o) => {
                    let code = o.status.code().unwrap_or(0);
                    format!(
                        r#"{{"status":"error","error":"OpenSky HTTP {}","source":"opensky"}}"#,
                        code
                    )
                }
                Err(e) => {
                    format!(
                        r#"{{"status":"error","error":"curl: {}","source":"opensky"}}"#,
                        jval(&e.to_string())
                    )
                }
            }
        }
        "adsb" => {
            // ADS-B Exchange — try their public-facing endpoint
            // The v2 API requires a key, but the public tar1090 instances can be queried
            let url = format!(
                "https://globe.adsbexchange.com/globe_history/{}/acas/acas.json",
                callsign.to_uppercase()
            );

            eprintln!("[rt-flight] ADS-B Exchange lookup: {}", callsign);

            // Try the public search endpoint
            let search_url = format!(
                "https://globe.adsbexchange.com/?icao={}", callsign.to_lowercase()
            );

            // Curl the ADS-B Exchange aircraft.json (public feed, limited)
            let adsb_url = "https://opensky-network.org/api/states/all";
            let out = Command::new(curl_cmd())
                .args([
                    "-s", "--max-time", &(cfg.timeout + 5).to_string(),
                    "-H", "User-Agent: WorldMonitor/1.0",
                    &adsb_url,
                ])
                .output();

            match out {
                Ok(o) if o.status.success() => {
                    let raw = String::from_utf8_lossy(&o.stdout);
                    let cs_upper = callsign.to_uppercase();
                    if raw.contains(&cs_upper) || raw.contains(&callsign.to_lowercase()) {
                        // Found — fall through to OpenSky parsing (same data)
                        format!(
                            r#"{{"status":"tracked","info":"Found {} in public feed (via OpenSky fallback). For dedicated ADS-B Exchange access, configure an API key in config.toml.","source":"adsb"}}"#,
                            jval(&callsign)
                        )
                    } else {
                        format!(
                            r#"{{"status":"not_found","info":"Callsign {} not found in current public ADS-B data. The aircraft may not be airborne.","source":"adsb"}}"#,
                            jval(&callsign)
                        )
                    }
                }
                _ => {
                    format!(
                        r#"{{"status":"error","error":"Could not reach ADS-B data source","source":"adsb"}}"#
                    )
                }
            }
        }
        "manual" => {
            format!(
                r#"{{"status":"manual","info":"Manual tracking entry for {}","source":"manual"}}"#,
                jval(&callsign)
            )
        }
        _ => r#"{"error":"unknown source"}"#.into(),
    }
}

/// Split a JSON array's inner content by top-level commas (respecting strings and nested arrays).
/// Look up flight route with file-based caching and rate limiting.
/// Cache file: /tmp/rt_route_cache.txt — one line per callsign: "CS\tDEP\tDEST\tTIME"
fn lookup_flight_route(callsign: &str) -> (String, String) {
    let cs = callsign.trim().to_uppercase();
    let cache_path = "/tmp/rt_route_cache.txt";

    // Check cache first
    if let Ok(contents) = std::fs::read_to_string(cache_path) {
        for line in contents.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 3 && parts[0] == cs {
                let dep = parts[1].to_string();
                let dest = parts[2].to_string();
                if !dep.is_empty() || !dest.is_empty() {
                    eprintln!("[rt-flight] Route cache hit for {}: {} → {}", cs, dep, dest);
                    return (dep, dest);
                }
                // Cached as "no route found" — check if it's recent (within 1 hour)
                if parts.len() >= 4 {
                    if let Ok(ts) = parts[3].parse::<u64>() {
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                        if now - ts < 3600 {
                            return (String::new(), String::new()); // cached negative result
                        }
                    }
                }
            }
        }
    }

    // Rate limit: check last API call time
    let rate_path = "/tmp/rt_route_last_call";
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    if let Ok(last) = std::fs::read_to_string(rate_path) {
        if let Ok(last_ts) = last.trim().parse::<u64>() {
            if now - last_ts < 6 {
                eprintln!("[rt-flight] Route lookup rate-limited for {} (last call {}s ago)", cs, now - last_ts);
                return (String::new(), String::new());
            }
        }
    }
    let _ = std::fs::write(rate_path, now.to_string());

    // Query OpenSky routes API
    let routes_url = format!("https://opensky-network.org/api/routes?callsign={}", cs);
    eprintln!("[rt-flight] Querying routes API for {}", cs);

    let (dep, dest) = match Command::new(curl_cmd())
        .args(["-s", "--max-time", "6",
            "-w", "\n%{http_code}",
            "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "-H", "Accept: application/json",
            &routes_url])
        .output()
    {
        Ok(o) => {
            let raw = String::from_utf8_lossy(&o.stdout).to_string();
            // Last line is the HTTP code from -w
            let lines: Vec<&str> = raw.rsplitn(2, '\n').collect();
            let http_code = lines.first().unwrap_or(&"0").trim();
            let body = lines.get(1).unwrap_or(&"").trim();

            eprintln!("[rt-flight] Routes API for {}: HTTP {} — {:.*}", cs, http_code, 300, body);

            if http_code == "429" {
                eprintln!("[rt-flight] Routes API rate-limited (429) for {}", cs);
                return (String::new(), String::new()); // Don't cache 429s
            }

            if http_code != "200" || body.is_empty() {
                (String::new(), String::new())
            } else if let Some(arr_start) = body.find("\"route\"") {
                let after = &body[arr_start..];
                if let Some(open) = after.find('[') {
                    if let Some(close) = after[open..].find(']') {
                        let items: Vec<String> = after[open+1..open+close]
                            .split(',')
                            .map(|s| s.trim().trim_matches('"').to_string())
                            .filter(|s| !s.is_empty())
                            .collect();
                        let d = items.first().cloned().unwrap_or_default();
                        let a = if items.len() > 1 { items.last().cloned().unwrap_or_default() } else { String::new() };
                        eprintln!("[rt-flight] Route found for {}: {} → {}", cs, d, a);
                        (d, a)
                    } else { (String::new(), String::new()) }
                } else { (String::new(), String::new()) }
            } else { (String::new(), String::new()) }
        }
        Err(e) => {
            eprintln!("[rt-flight] Routes API error for {}: {}", cs, e);
            (String::new(), String::new())
        }
    };

    // Cache the result (append to file)
    let cache_line = format!("{}\t{}\t{}\t{}\n", cs, dep, dest, now);
    let _ = std::fs::OpenOptions::new().create(true).append(true)
        .open(cache_path).and_then(|mut f| {
            use std::io::Write;
            f.write_all(cache_line.as_bytes())
        });

    (dep, dest)
}

/// Look up airline name from ICAO callsign prefix (first 3 characters)
fn icao_airline_name(callsign: &str) -> String {
    let cs = callsign.trim().to_uppercase();
    if cs.len() < 3 { return String::new(); }
    let prefix = &cs[..3];

    match prefix {
        "UAL" => "United Airlines".into(),
        "DAL" => "Delta Air Lines".into(),
        "AAL" => "American Airlines".into(),
        "SWA" => "Southwest Airlines".into(),
        "JBU" => "JetBlue Airways".into(),
        "NKS" => "Spirit Airlines".into(),
        "FFT" => "Frontier Airlines".into(),
        "ASA" => "Alaska Airlines".into(),
        "HAL" => "Hawaiian Airlines".into(),
        "SKW" => "SkyWest Airlines".into(),
        "RPA" => "Republic Airways".into(),
        "ENY" => "Envoy Air".into(),
        "PDT" => "Piedmont Airlines".into(),
        "EJA" => "NetJets".into(),
        "AXB" => "Air India Express".into(),
        "AIQ" => "AirAsia India".into(),
        "BAW" => "British Airways".into(),
        "DLH" => "Lufthansa".into(),
        "AFR" => "Air France".into(),
        "KLM" => "KLM Royal Dutch".into(),
        "EZY" => "easyJet".into(),
        "RYR" => "Ryanair".into(),
        "UAE" => "Emirates".into(),
        "QTR" => "Qatar Airways".into(),
        "ETH" => "Ethiopian Airlines".into(),
        "SIA" => "Singapore Airlines".into(),
        "CPA" => "Cathay Pacific".into(),
        "ANA" => "All Nippon Airways".into(),
        "JAL" => "Japan Airlines".into(),
        "KAL" => "Korean Air".into(),
        "CCA" => "Air China".into(),
        "CES" => "China Eastern".into(),
        "CSN" => "China Southern".into(),
        "THY" => "Turkish Airlines".into(),
        "QFA" => "Qantas".into(),
        "ANZ" => "Air New Zealand".into(),
        "ACA" => "Air Canada".into(),
        "WJA" => "WestJet".into(),
        "TAM" => "LATAM Brasil".into(),
        "LAN" => "LATAM Chile".into(),
        "AVA" => "Avianca".into(),
        "VOI" => "Volaris".into(),
        "AMX" => "Aeromexico".into(),
        "JST" => "Jetstar Airways".into(),
        "VOZ" => "Virgin Australia".into(),
        "ZKM" | "ZKJ" | "ZKN" => "Air New Zealand Link".into(),
        "EIN" => "Aer Lingus".into(),
        "FIN" => "Finnair".into(),
        "SAS" => "SAS Scandinavian".into(),
        "IBE" => "Iberia".into(),
        "TAP" => "TAP Air Portugal".into(),
        "SWR" => "Swiss Intl Air".into(),
        "AUA" => "Austrian Airlines".into(),
        _ => String::new(),
    }
}

fn split_json_array(s: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let mut depth = 0;
    let mut in_string = false;
    let mut escape = false;
    let mut start = 0;

    for (i, c) in s.char_indices() {
        if escape {
            escape = false;
            continue;
        }
        if c == '\\' && in_string {
            escape = true;
            continue;
        }
        if c == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match c {
            '[' | '{' => depth += 1,
            ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                result.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    result.push(&s[start..]);
    result
}

/// Remove JSON string quotes from a value like `"hello"` -> `hello`.
fn clean_json_str(s: &str) -> String {
    let t = s.trim();
    if t.starts_with('"') && t.ends_with('"') && t.len() >= 2 {
        t[1..t.len() - 1].to_string()
    } else if t == "null" {
        String::new()
    } else {
        t.to_string()
    }
}

fn do_rt_ask(st: &Shared, body: &str) -> String {
    let query = jget(body, "query").unwrap_or_default();
    let context = jget(body, "context").unwrap_or_default();

    if query.is_empty() {
        return r#"{"error":"No query"}"#.into();
    }

    let (cfg, can_ai, ready) = {
        let s = st.lock().unwrap();
        (s.cfg.clone(), s.usage.check(&s.cfg).is_ok(), s.llama.is_ready())
    };

    if !can_ai || !ready {
        let why = if !cfg.has_ai() {
            "No model loaded. Select one in settings."
        } else if !ready {
            "Model still loading..."
        } else {
            "Token budget exhausted."
        };
        return format!(r#"{{"answer":"{}","tokens":0}}"#, jval(why));
    }

    let system = format!(
        "You are an OSINT and real-time monitoring assistant. You help users find and analyze \
         publicly available data sources including: public traffic cameras (DOT feeds), \
         flight tracking (ADS-B, OpenSky), maritime tracking (AIS), weather stations, \
         and public network services. You provide accurate, actionable information about \
         accessing legitimate public data feeds. You have the following current monitoring state:\n\n{}",
        context
    );

    eprintln!("[rt-ask] {}", query);

    match ai_call(&cfg, &system, &query) {
        Ok(r) => {
            st.lock().unwrap().usage.add(r.tokens);
            eprintln!("[rt-ask] {} tok {:.1}s", r.tokens, r.elapsed_ms as f64 / 1000.0);
            format!(
                r#"{{"answer":"{}","tokens":{},"elapsed_ms":{}}}"#,
                jval(&r.text),
                r.tokens,
                r.elapsed_ms
            )
        }
        Err(e) => {
            eprintln!("[rt-ask] err: {e}");
            format!(r#"{{"answer":"Error: {}","tokens":0,"elapsed_ms":0}}"#, jval(&e))
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY CRAWLER — finds public cameras, NPS webcams, DOT feeds, flights
// ═══════════════════════════════════════════════════════════════════════════════

/// Main discovery endpoint. Crawls multiple public sources in parallel.
fn do_rt_discover(st: &Shared, body: &str) -> String {
    let dtype = jget(body, "type").unwrap_or("all".into());
    let cfg = st.lock().unwrap().cfg.clone();
    let timeout = (cfg.timeout + 5).to_string();

    let cameras: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let flights: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    // ── Camera Discovery (parallel) ───────────────────────────────────
    if dtype == "cameras" || dtype == "all" {
        eprintln!("[discover] Starting camera discovery...");
        log.lock().unwrap().push("Starting camera discovery...".into());

        let mut handles = Vec::new();

        // Source 1: Curated DOT traffic cameras (known-good direct image URLs)
        {
            let cam = Arc::clone(&cameras);
            let lg = Arc::clone(&log);
            let to = timeout.clone();
            handles.push(std::thread::spawn(move || {
                lg.lock().unwrap().push("Verifying DOT traffic cameras...".into());
                let found = discover_dot_catalog(&to);
                lg.lock().unwrap().push(format!("DOT catalog: {} live cameras", found.len()));
                cam.lock().unwrap().extend(found);
            }));
        }

        // Source 2: Caltrans CCTV (crawl their camera list page for hundreds of cams)
        {
            let cam = Arc::clone(&cameras);
            let lg = Arc::clone(&log);
            let to = timeout.clone();
            handles.push(std::thread::spawn(move || {
                lg.lock().unwrap().push("Crawling Caltrans CCTV list...".into());
                let found = discover_caltrans(&to);
                lg.lock().unwrap().push(format!("Caltrans: {} cameras", found.len()));
                cam.lock().unwrap().extend(found);
            }));
        }

        // Source 3: National Park Service webcams
        {
            let cam = Arc::clone(&cameras);
            let lg = Arc::clone(&log);
            let to = timeout.clone();
            handles.push(std::thread::spawn(move || {
                lg.lock().unwrap().push("Verifying NPS & public webcams...".into());
                let found = discover_nps_and_public(&to);
                lg.lock().unwrap().push(format!("NPS/public: {} live webcams", found.len()));
                cam.lock().unwrap().extend(found);
            }));
        }

        // Source 4: Insecam directory (scrape US page for direct camera URLs)
        {
            let cam = Arc::clone(&cameras);
            let lg = Arc::clone(&log);
            let to = timeout.clone();
            handles.push(std::thread::spawn(move || {
                lg.lock().unwrap().push("Crawling Insecam US directory...".into());
                let found = discover_insecam(&to);
                lg.lock().unwrap().push(format!("Insecam: {} cameras", found.len()));
                cam.lock().unwrap().extend(found);
            }));
        }

        // Source 5: 511 state traffic APIs (expanded)
        {
            let cam = Arc::clone(&cameras);
            let lg = Arc::clone(&log);
            let to = timeout.clone();
            handles.push(std::thread::spawn(move || {
                lg.lock().unwrap().push("Crawling 511 state APIs...".into());
                let found = discover_511_all(&to);
                lg.lock().unwrap().push(format!("511 APIs: {} cameras", found.len()));
                cam.lock().unwrap().extend(found);
            }));
        }

        // Source 6: NYC DOT Traffic Management Center (919 cameras, no auth, direct JPEG)
        {
            let cam = Arc::clone(&cameras);
            let lg = Arc::clone(&log);
            let to = timeout.clone();
            handles.push(std::thread::spawn(move || {
                lg.lock().unwrap().push("Crawling NYC TMC camera API...".into());
                let found = discover_nyctmc(&to);
                lg.lock().unwrap().push(format!("NYC TMC: {} cameras", found.len()));
                cam.lock().unwrap().extend(found);
            }));
        }

        for h in handles { let _ = h.join(); }

        let count = cameras.lock().unwrap().len();
        log.lock().unwrap().push(format!("Camera discovery complete: {} total feeds", count));
        eprintln!("[discover] {} cameras found", count);
    }

    // ── Flight Discovery ──────────────────────────────────────────────
    if dtype == "flights" || dtype == "all" {
        eprintln!("[discover] Crawling OpenSky for live flights...");
        log.lock().unwrap().push("Querying OpenSky Network...".into());

        let found = discover_opensky_flights(&timeout);
        log.lock().unwrap().push(format!("OpenSky: {} flights sampled", found.len()));
        flights.lock().unwrap().extend(found);
    }

    // Build response
    let cams = cameras.lock().unwrap();
    let flts = flights.lock().unwrap();
    let logs = log.lock().unwrap();

    let cam_json = cams.join(",");
    let flight_json = flts.join(",");
    let log_json = logs.iter()
        .map(|l| format!("\"{}\"", jval(l)))
        .collect::<Vec<_>>()
        .join(",");

    format!(
        r#"{{"cameras":[{}],"flights":[{}],"log":[{}],"total_cameras":{},"total_flights":{}}}"#,
        cam_json, flight_json, log_json, cams.len(), flts.len()
    )
}

// ── Source 1: Curated DOT Traffic Camera Catalog ──────────────────────────
// Known-good direct-image URLs from state DOTs. These are publicly served
// JPEG snapshot endpoints that DOTs expose for public traveler information.
// We verify each one with a fast HEAD check before returning it.

fn discover_dot_catalog(_timeout: &str) -> Vec<String> {
    // All static WSDOT/MnDOT/FDOT URLs confirmed broken through proxy.
    // These DOTs block non-browser requests or require session cookies.
    // Working sources: Caltrans (discovery), NYC TMC (API), 511 state APIs.
    Vec::new()
}

// ── Source 2: Caltrans CCTV List Crawler ──────────────────────────────────
// Caltrans exposes camera images at predictable URLs.
// We crawl their documentation page to find camera IDs, then build image URLs.

fn discover_caltrans(timeout: &str) -> Vec<String> {
    let mut results;

    // Caltrans publishes per-district CCTV status JSON files.
    // Each contains real camera image URLs that are currently active.
    // Districts: 1-12 (not all have cameras)
    let districts = [
        ("D3", "https://cwwp2.dot.ca.gov/data/d3/cctv/cctvStatusD03.json"),
        ("D4", "https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json"),
        ("D5", "https://cwwp2.dot.ca.gov/data/d5/cctv/cctvStatusD05.json"),
        ("D6", "https://cwwp2.dot.ca.gov/data/d6/cctv/cctvStatusD06.json"),
        ("D7", "https://cwwp2.dot.ca.gov/data/d7/cctv/cctvStatusD07.json"),
        ("D8", "https://cwwp2.dot.ca.gov/data/d8/cctv/cctvStatusD08.json"),
        ("D10", "https://cwwp2.dot.ca.gov/data/d10/cctv/cctvStatusD10.json"),
        ("D11", "https://cwwp2.dot.ca.gov/data/d11/cctv/cctvStatusD11.json"),
        ("D12", "https://cwwp2.dot.ca.gov/data/d12/cctv/cctvStatusD12.json"),
    ];

    let all_results: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let all_seen: Arc<Mutex<std::collections::HashSet<String>>> = Arc::new(Mutex::new(std::collections::HashSet::new()));
    let mut handles = Vec::new();

    for (district, url) in districts {
        let r = Arc::clone(&all_results);
        let s = Arc::clone(&all_seen);
        let to = timeout.to_string();
        let dist = district.to_string();
        let api = url.to_string();

        handles.push(std::thread::spawn(move || {
            let out = Command::new(curl_cmd())
                .args([
                    "-s", "-L", "--max-time", &to,
                    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "-H", "Referer: https://cwwp2.dot.ca.gov/",
                    "-H", "Accept: application/json, */*",
                    &api,
                ])
                .output();

            let raw = match out {
                Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
                _ => return,
            };

            if raw.len() < 200 { return; }

            // Extract image URLs — look for "currentImageURL" or any URL containing /cctv/image/
            let mut pos = 0;
            let mut count = 0;
            while pos < raw.len() && count < 30 {
                // Look for image URL patterns in the JSON
                let url_idx = raw[pos..].find("/cctv/image/")
                    .or_else(|| raw[pos..].find("currentImageURL"))
                    .or_else(|| raw[pos..].find("currentImageUrl"));

                let abs = match url_idx {
                    Some(i) => pos + i,
                    None => break,
                };

                // If we found a key like "currentImageURL", extract the value
                if raw[abs..].starts_with("currentImage") {
                    if let Some(colon) = raw[abs..].find(':') {
                        let val_start = abs + colon;
                        if let Some(url_val) = extract_json_string_after(&raw[val_start..]) {
                            if url_val.starts_with("http") && !s.lock().unwrap().contains(&url_val) {
                                s.lock().unwrap().insert(url_val.clone());
                                let cam_name = extract_caltrans_name(&raw, abs, &dist);
                                r.lock().unwrap().push(format!(
                                    r#"{{"name":"{}","url":"{}","type":"image","cat":"traffic","source":"Caltrans {}","region":"West"}}"#,
                                    jval(&cam_name), jval(&url_val), jval(&dist)
                                ));
                                count += 1;
                            }
                        }
                    }
                    pos = abs + 20;
                } else {
                    // Found /cctv/image/ in a URL string — extract the full URL
                    // Walk backwards to find http
                    let mut url_start = abs;
                    while url_start > 0 {
                        if raw[url_start..].starts_with("http") { break; }
                        url_start -= 1;
                    }
                    // Walk forwards to find end of URL (quote or whitespace)
                    let mut url_end = abs + 12;
                    while url_end < raw.len() {
                        let ch = raw.as_bytes()[url_end];
                        if ch == b'"' || ch == b'\'' || ch == b' ' || ch == b',' || ch == b'}' { break; }
                        url_end += 1;
                    }

                    if raw[url_start..].starts_with("http") {
                        let url_val = raw[url_start..url_end].to_string();
                        if !s.lock().unwrap().contains(&url_val) {
                            s.lock().unwrap().insert(url_val.clone());
                            let cam_name = extract_caltrans_name(&raw, abs, &dist);
                            r.lock().unwrap().push(format!(
                                r#"{{"name":"{}","url":"{}","type":"image","cat":"traffic","source":"Caltrans {}","region":"West"}}"#,
                                jval(&cam_name), jval(&url_val), jval(&dist)
                            ));
                            count += 1;
                        }
                    }
                    pos = url_end;
                }
            }
        }));
    }

    for h in handles { let _ = h.join(); }
    results = Arc::try_unwrap(all_results).unwrap().into_inner().unwrap();

    // If JSON APIs returned nothing, use the one confirmed working URL
    if results.is_empty() {
        results.push(format!(
            r#"{{"name":"Caltrans I-80 Bay Bridge East Tower","url":"https://cwwp2.dot.ca.gov/data/d4/cctv/image/tvd32i80baybridgesastowereast/tvd32i80baybridgesastowereast.jpg","type":"image","cat":"traffic","source":"Caltrans","region":"West"}}"#
        ));
    }

    results
}

/// Extract a descriptive name for a Caltrans camera from nearby JSON context
fn extract_caltrans_name(raw: &str, pos: usize, district: &str) -> String {
    let ctx_start = if pos > 600 { pos - 600 } else { 0 };
    let ctx = &raw[ctx_start..pos];

    // Look for location/route info
    let name_keys = ["\"location\"", "\"nearbyPlace\"", "\"routeName\"", "\"county\""];
    for key in &name_keys {
        if let Some(kp) = ctx.rfind(key) {
            if let Some(val) = extract_json_string_after(&ctx[kp + key.len()..]) {
                if !val.is_empty() && val.len() < 100 {
                    return format!("Caltrans {} {}", district, val);
                }
            }
        }
    }

    // Try to extract from the URL path itself: /image/{camid}/{camid}.jpg
    if let Some(img_idx) = raw[pos..].find("/image/") {
        let after = pos + img_idx + 7;
        if let Some(slash) = raw[after..].find('/') {
            let cam_id = &raw[after..after + slash];
            let name = cam_id
                .replace("tvd", "").replace("tvf", "").replace("tvc", "")
                .chars().map(|c| if c.is_alphanumeric() { c } else { ' ' })
                .collect::<String>();
            return format!("Caltrans {}", name.trim());
        }
    }

    format!("Caltrans {} Camera", district)
}

// ── Source 3: National Parks + Public Webcams ──────────────────────────────

fn discover_nps_and_public(_timeout: &str) -> Vec<String> {
    // All static USGS/NOAA/FAA URLs confirmed broken through proxy.
    // USGS HVO cams return placeholder images, NOAA/FAA block non-browser requests.
    // Working sources: NYC TMC (API), Caltrans (discovery), 511 state APIs.
    Vec::new()
}

// ── Source 4: Insecam Directory Scraper ───────────────────────────────────
// Insecam indexes cameras broadcasting without authentication.
// We scrape their US pages to find direct MJPEG/JPEG URLs.

fn discover_insecam(timeout: &str) -> Vec<String> {
    let mut all_results = Vec::new();

    // Crawl multiple pages of US cameras
    for page in 1..=5 {
        let url = if page == 1 {
            "http://www.insecam.org/en/bycountry/US/".to_string()
        } else {
            format!("http://www.insecam.org/en/bycountry/US/?page={}", page)
        };

        let out = Command::new(curl_cmd())
            .args([
                "-s", "-L", "--max-time", timeout,
                "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "-H", "Accept: text/html",
                &url,
            ])
            .output();

        let html = match out {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
            _ => continue,
        };

        if html.len() < 500 { continue; }

        // Insecam page structure: each camera has an <img> tag with src pointing
        // to the camera's snapshot. Look for image URLs in the page.
        // Pattern: src="http://..." inside camera thumbnail divs
        let results = extract_insecam_urls(&html, page);
        all_results.extend(results);

        // Don't hammer the site
        std::thread::sleep(Duration::from_millis(500));
    }

    all_results
}

/// Extract camera URLs from Insecam HTML page
fn extract_insecam_urls(html: &str, page: usize) -> Vec<String> {
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Insecam embeds camera images with patterns like:
    //   <img src="http://camera-ip:port/..." ...>
    // inside <div class="thumbnail-item">
    // Also look for direct links to camera pages

    let mut pos = 0;
    while pos < html.len() && results.len() < 40 {
        // Find img tags or links with camera URLs
        let search = &html[pos..];

        // Look for src="http://..." patterns pointing to camera IPs
        if let Some(src_idx) = search.find("src=\"http") {
            let abs = pos + src_idx + 5; // skip src="
            if let Some(end_quote) = html[abs..].find('"') {
                let url = &html[abs..abs + end_quote];

                // Filter for likely camera URLs (IP addresses with common cam ports/paths)
                let is_camera = (url.contains(":80/") || url.contains(":8080/")
                    || url.contains(":8081/") || url.contains(":554/")
                    || url.contains(":8888/") || url.contains(":81/")
                    || url.contains("/mjpg/") || url.contains("/video")
                    || url.contains("/axis-cgi/") || url.contains("/snap")
                    || url.contains("/jpg/") || url.contains("/image")
                    || url.contains("/cgi-bin/") || url.contains("/snapshot"))
                    && !url.contains("insecam.org")
                    && !url.contains("google")
                    && !url.contains("facebook")
                    && !url.contains("adsense")
                    && url.starts_with("http");

                if is_camera && !seen.contains(url) {
                    seen.insert(url.to_string());
                    let cam_type = if url.contains("mjpg") || url.contains("video") {
                        "mjpeg"
                    } else {
                        "image"
                    };

                    let name = format!("Insecam US #{}", (page - 1) * 40 + results.len() + 1);
                    results.push(format!(
                        r#"{{"name":"{}","url":"{}","type":"{}","cat":"public","source":"Insecam","region":"US"}}"#,
                        jval(&name), jval(url), cam_type
                    ));
                }
                pos = abs + end_quote;
            } else {
                pos += src_idx + 10;
            }
        } else {
            break;
        }
    }

    results
}

// ── Source 5: 511 State Traffic Camera APIs (expanded) ────────────────────

fn discover_511_all(timeout: &str) -> Vec<String> {
    let apis: Vec<(&str, &str, &str)> = vec![
        // (source, url, region)
        ("IA 511",  "https://lb.511ia.org/ialb/cameras/camera.json", "Midwest"),
        ("NE 511",  "https://lb.511.nebraska.gov/nelb/cameras/camera.json", "Midwest"),
        ("KY 511",  "https://lb.511.ky.gov/kylb/cameras/camera.json", "Southeast"),
        ("WY 511",  "https://lb.511.wy.gov/wylb/cameras/camera.json", "West"),
        ("LA 511",  "https://lb.511la.org/lalb/cameras/camera.json", "South"),
        ("IN 511",  "https://lb.511in.org/inlb/cameras/camera.json", "Midwest"),
        ("MS 511",  "https://lb.mdottraffic.com/mslb/cameras/camera.json", "South"),
        ("AR 511",  "https://lb.idrivearkansas.com/arlb/cameras/camera.json", "South"),
        ("SD 511",  "https://lb.sd511.org/sdlb/cameras/camera.json", "Midwest"),
        ("ND 511",  "https://lb.511nd.gov/ndlb/cameras/camera.json", "Midwest"),
        ("ME 511",  "https://lb.newengland511.org/melb/cameras/camera.json", "Northeast"),
        ("VA 511",  "https://lb.511virginia.org/valb/cameras/camera.json", "Southeast"),
        ("TN 511",  "https://lb.smartway.tn.gov/tnlb/cameras/camera.json", "Southeast"),
        ("KS 511",  "https://lb.kandrive.org/kslb/cameras/camera.json", "Midwest"),
        ("MO 511",  "https://lb.traveler.modot.org/molb/cameras/camera.json", "Midwest"),
        ("MT 511",  "https://lb.511mt.net/mtlb/cameras/camera.json", "West"),
        ("AL 511",  "https://lb.algotraffic.com/allb/cameras/camera.json", "Southeast"),
        ("SC 511",  "https://lb.511sc.org/sclb/cameras/camera.json", "Southeast"),
        ("OK 511",  "https://lb.pikepass.com/oklb/cameras/camera.json", "South"),
        ("NM 511",  "https://lb.nmroads.com/nmlb/cameras/camera.json", "West"),
        ("WV 511",  "https://lb.wv511.org/wvlb/cameras/camera.json", "Southeast"),
        ("NH 511",  "https://lb.newengland511.org/nhlb/cameras/camera.json", "Northeast"),
    ];

    let results: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();

    for (source, url, region) in apis {
        let r = Arc::clone(&results);
        let to = timeout.to_string();
        let src = source.to_string();
        let api_url = url.to_string();
        let reg = region.to_string();

        handles.push(std::thread::spawn(move || {
            if let Some(cams) = fetch_511_cameras(&api_url, &src, &to, &reg) {
                r.lock().unwrap().extend(cams);
            }
        }));
    }

    for h in handles { let _ = h.join(); }
    Arc::try_unwrap(results).unwrap().into_inner().unwrap()
}

/// Fetch and parse cameras from a 511 API endpoint
fn fetch_511_cameras(url: &str, source: &str, timeout: &str, region: &str) -> Option<Vec<String>> {
    let out = Command::new(curl_cmd())
        .args([
            "-s", "--max-time", timeout,
            "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "-H", "Accept: application/json, */*",
            url,
        ])
        .output()
        .ok()?;

    if !out.status.success() { return None; }

    let raw = String::from_utf8_lossy(&out.stdout).to_string();
    if raw.len() < 100 { return None; }

    parse_511_camera_json(&raw, source, region)
}

/// Parse 511-style camera JSON. These APIs return arrays of camera objects
/// with various field names for the image URL.
/// Accept ANY http URL found under camera-related keys — the proxy handles
/// the actual fetch, and dead feeds simply show "Feed unavailable" in the UI.
fn parse_511_camera_json(raw: &str, source: &str, region: &str) -> Option<Vec<String>> {
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let url_keys = [
        "\"Url\"", "\"url\"", "\"ImageUrl\"", "\"imageUrl\"",
        "\"ImageURL\"", "\"StreamUrl\"", "\"streamUrl\"",
        "\"VideoUrl\"", "\"videoUrl\"",
    ];
    let name_keys = [
        "\"Name\"", "\"name\"", "\"Description\"", "\"description\"",
        "\"Location\"", "\"location\"", "\"Title\"", "\"title\"",
    ];

    let mut pos = 0;
    while pos < raw.len() && results.len() < 100 {
        // Find the nearest URL key
        let mut best: Option<(usize, &str)> = None;
        for key in &url_keys {
            if let Some(p) = raw[pos..].find(key) {
                if best.is_none() || p < best.unwrap().0 {
                    best = Some((p, key));
                }
            }
        }

        let (offset, key) = match best {
            Some(b) => b,
            None => break,
        };

        let key_pos = pos + offset;
        let after = key_pos + key.len();

        if let Some(url_val) = extract_json_string_after(&raw[after..]) {
            // Accept any http(s) URL that isn't obviously a webpage/API doc link
            let dominated = url_val.starts_with("http")
                && !url_val.is_empty()
                && !url_val.ends_with(".html")
                && !url_val.ends_with(".htm")
                && !url_val.contains("/api/doc")
                && !url_val.contains("/swagger")
                && url_val.len() > 15;

            if dominated && !seen.contains(&url_val) {
                seen.insert(url_val.clone());

                let context_start = if key_pos > 500 { key_pos - 500 } else { 0 };
                let context = &raw[context_start..key_pos];
                let cam_name = extract_json_name(context, &name_keys)
                    .unwrap_or_else(|| format!("{} Cam {}", source, results.len() + 1));

                let cam_type = if url_val.contains("mjpg") || url_val.contains("video.cgi")
                    || url_val.contains("m3u8") || url_val.contains("stream") {
                    "mjpeg"
                } else {
                    "image"
                };

                results.push(format!(
                    r#"{{"name":"{}","url":"{}","type":"{}","cat":"traffic","source":"{}","region":"{}"}}"#,
                    jval(&cam_name), jval(&url_val), cam_type, jval(source), jval(region)
                ));
            }
        }

        pos = after + 1;
    }

    if results.is_empty() { None } else { Some(results) }
}

/// Extract a JSON string value that follows a colon
fn extract_json_string_after(s: &str) -> Option<String> {
    let s = s.trim_start();
    let s = s.strip_prefix(':')?;
    let s = s.trim_start();
    if !s.starts_with('"') { return None; }
    let mut chars = s[1..].chars();
    let mut val = String::new();
    loop {
        match chars.next()? {
            '"' => break,
            '\\' => {
                match chars.next()? {
                    '"' => val.push('"'),
                    '\\' => val.push('\\'),
                    'n' => val.push('\n'),
                    '/' => val.push('/'),
                    o => { val.push('\\'); val.push(o); }
                }
            }
            c => val.push(c),
        }
    }
    if val.is_empty() { None } else { Some(val) }
}

/// Try to extract a camera name from nearby JSON context
fn extract_json_name(context: &str, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(kp) = context.rfind(key) {
            let after = &context[kp + key.len()..];
            if let Some(val) = extract_json_string_after(after) {
                if !val.is_empty() && val.len() < 150
                    && !val.starts_with("http")
                    && !val.contains("Disabled")
                {
                    return Some(val);
                }
            }
        }
    }
    None
}

// ── Source 6: NYC DOT Traffic Management Center ──────────────────────────
// API: https://webcams.nyctmc.org/api/cameras → JSON array of 900+ cameras
// Image: https://webcams.nyctmc.org/api/cameras/{id}/image → direct JPEG, no auth
// Each camera has: id (UUID), name, latitude, longitude, area (borough), isOnline

fn discover_nyctmc(timeout: &str) -> Vec<String> {
    let api_url = "https://webcams.nyctmc.org/api/cameras";
    eprintln!("[discover-nyctmc] Fetching camera list from {}", api_url);

    let out = match Command::new(curl_cmd())
        .args([
            "-s", "--max-time", timeout,
            "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "-H", "Accept: application/json",
            api_url,
        ])
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[discover-nyctmc] curl error: {}", e);
            return Vec::new();
        }
    };

    if !out.status.success() {
        eprintln!("[discover-nyctmc] curl failed with exit code {:?}", out.status.code());
        return Vec::new();
    }

    let raw = String::from_utf8_lossy(&out.stdout).to_string();
    if raw.len() < 200 {
        eprintln!("[discover-nyctmc] Response too short ({} bytes)", raw.len());
        return Vec::new();
    }

    eprintln!("[discover-nyctmc] Got {} bytes of camera data", raw.len());

    // Parse JSON array of camera objects:
    // {"id":"UUID","name":"...","latitude":40.7,"longitude":-73.9,"area":"Manhattan","isOnline":"true"}
    // We'll parse by scanning for id+name+area fields to build image URLs.
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Split by "id" field occurrences
    let id_key = "\"id\"";
    let mut pos = 0;
    while pos < raw.len() && results.len() < 200 {
        let id_pos = match raw[pos..].find(id_key) {
            Some(p) => pos + p,
            None => break,
        };

        // Extract the object context (roughly 500 chars after the id key)
        let obj_end = std::cmp::min(id_pos + 500, raw.len());
        let chunk = &raw[id_pos..obj_end];

        // Extract id value
        let cam_id = match extract_json_field(chunk, "\"id\"") {
            Some(v) if v.len() > 10 && v.contains('-') => v, // UUID pattern
            _ => { pos = id_pos + id_key.len(); continue; }
        };

        // Extract name
        let name = extract_json_field(chunk, "\"name\"")
            .unwrap_or_else(|| format!("NYC Cam {}", results.len() + 1));

        // Extract area (borough)
        let area = extract_json_field(chunk, "\"area\"")
            .unwrap_or_else(|| "NYC".into());

        // Check isOnline (handles both "true" string and true boolean)
        let is_online = if let Some(kp) = chunk.find("\"isOnline\"") {
            let after = &chunk[kp + 10..std::cmp::min(kp + 25, chunk.len())];
            after.contains("true") || after.contains("True")
        } else {
            true // assume online if field missing
        };

        if !is_online {
            pos = id_pos + id_key.len();
            continue;
        }

        // Build direct image URL
        let image_url = format!("https://webcams.nyctmc.org/api/cameras/{}/image", cam_id);

        if !seen.contains(&cam_id) {
            seen.insert(cam_id.clone());

            let display_name = format!("NYC {} — {}", area, name);
            results.push(format!(
                r#"{{"name":"{}","url":"{}","type":"image","cat":"traffic","source":"NYC DOT","region":"Northeast"}}"#,
                jval(&display_name), jval(&image_url)
            ));
        }

        pos = id_pos + id_key.len();
    }

    eprintln!("[discover-nyctmc] Parsed {} online cameras", results.len());
    results
}

/// Extract a JSON field value from a chunk of JSON text
fn extract_json_field(chunk: &str, key: &str) -> Option<String> {
    let kp = chunk.find(key)?;
    let after = &chunk[kp + key.len()..];
    extract_json_string_after(after)
}

// ── OpenSky Flight Discovery ──────────────────────────────────────────────

fn discover_opensky_flights(timeout: &str) -> Vec<String> {
    let out = Command::new(curl_cmd())
        .args([
            "-s", "--max-time", timeout,
            "-H", "User-Agent: WorldMonitor/1.0",
            "https://opensky-network.org/api/states/all",
        ])
        .output();

    let raw = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return Vec::new(),
    };

    if !raw.contains("\"states\"") || raw.contains("\"states\":null") {
        return Vec::new();
    }

    let mut flights = Vec::new();
    if let Some(states_start) = raw.find("\"states\":") {
        let states_area = &raw[states_start..];
        let mut pos = 0;
        let mut count = 0;

        while count < 50 {
            let search = &states_area[pos..];
            if let Some(arr_start) = search.find("[\"") {
                let abs = pos + arr_start;
                if let Some(arr_end) = states_area[abs..].find(']') {
                    let inner = &states_area[abs + 1..abs + arr_end];
                    let fields = split_json_array(inner);

                    let icao = clean_json_str(fields.get(0).unwrap_or(&""));
                    let callsign = clean_json_str(fields.get(1).unwrap_or(&"")).trim().to_string();
                    let origin = clean_json_str(fields.get(2).unwrap_or(&""));
                    let lng: f64 = fields.get(5).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
                    let lat: f64 = fields.get(6).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
                    let alt: f64 = fields.get(7).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
                    let on_ground = fields.get(8).map(|s| s.trim() == "true").unwrap_or(false);
                    let velocity: f64 = fields.get(9).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);

                    if !callsign.is_empty() && !on_ground && alt > 100.0 {
                        flights.push(format!(
                            r#"{{"callsign":"{}","icao":"{}","origin":"{}","lat":{:.4},"lng":{:.4},"alt":{:.0},"velocity":{:.0},"on_ground":false}}"#,
                            jval(&callsign), jval(&icao), jval(&origin), lat, lng, alt, velocity
                        ));
                        count += 1;
                    }
                    pos = abs + arr_end + 1;
                } else { break; }
            } else { break; }
        }
    }

    flights
}

/// Proxy a camera image through the server to avoid CORS issues.
/// For MJPEG streams, grabs a short burst and extracts the first JPEG frame.
/// GET /api/rt/cam/proxy?url=<encoded_url>
fn do_rt_cam_proxy(_st: &Shared, path: &str) -> Vec<u8> {
    let url = path
        .split('?')
        .nth(1)
        .and_then(|qs| {
            qs.split('&').find_map(|param| {
                let mut kv = param.splitn(2, '=');
                let key = kv.next()?;
                let val = kv.next()?;
                if key == "url" {
                    Some(urlparse_decode(val))
                } else {
                    None
                }
            })
        })
        .unwrap_or_default();

    if url.is_empty() {
        return http_error_response(400, b"No url parameter");
    }

    // Derive Referer from the camera URL's origin — DOT servers need this
    let referer = {
        if let Some(idx) = url.find("://") {
            let after = &url[idx + 3..];
            let host_end = after.find('/').unwrap_or(after.len());
            format!("{}/", &url[..idx + 3 + host_end])
        } else { String::new() }
    };

    let out = Command::new(curl_cmd())
        .args([
            "-s", "-L",
            "--max-time", "8",
            "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "-H", &format!("Referer: {}", referer),
            "-H", "Accept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            &url,
        ])
        .output();

    match out {
        Ok(o) if !o.stdout.is_empty() => {
            let data = &o.stdout;

            // Try to extract a JPEG frame from the data.
            // For MJPEG streams (multipart/x-mixed-replace), the stream
            // contains boundary markers + headers + JPEG data.
            // We look for JPEG SOI (FF D8 FF) and EOI (FF D9) markers.
            let jpeg = extract_jpeg_frame(data);

            if let Some(frame) = jpeg {
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                    frame.len()
                );
                let mut r = header.into_bytes();
                r.extend_from_slice(frame);
                return r;
            }

            // Not JPEG/MJPEG — detect type from magic bytes
            let ct = if data.starts_with(b"\x89PNG") {
                "image/png"
            } else if data.starts_with(b"GIF8") {
                "image/gif"
            } else if data.starts_with(b"RIFF") {
                "image/webp"
            } else {
                "application/octet-stream"
            };

            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                ct, data.len()
            );
            let mut r = header.into_bytes();
            r.extend_from_slice(data);
            r
        }
        _ => http_error_response(502, b"Feed unavailable"),
    }
}

/// Extract the first complete JPEG frame from raw bytes.
/// Looks for SOI marker (FF D8 FF) and EOI marker (FF D9).
fn extract_jpeg_frame(data: &[u8]) -> Option<&[u8]> {
    // Find JPEG Start Of Image
    let soi = find_bytes(data, &[0xFF, 0xD8, 0xFF])?;

    // Find JPEG End Of Image after SOI
    let search_from = soi + 3;
    if search_from >= data.len() {
        return None;
    }

    // Search for FF D9 (EOI) — but FF D9 can appear inside entropy-coded data,
    // so find the LAST one in a reasonable range, or the first one that's followed
    // by a boundary or end of data
    let mut eoi_pos = None;
    let mut i = search_from;
    while i < data.len() - 1 {
        if data[i] == 0xFF && data[i + 1] == 0xD9 {
            eoi_pos = Some(i + 2);
            // For MJPEG, the first EOI is typically the correct one
            break;
        }
        i += 1;
    }

    let end = eoi_pos?;
    if end - soi < 1000 {
        // Too small to be a real frame, skip this and look for next
        let next_data = &data[end..];
        if let Some(frame) = extract_jpeg_frame(next_data) {
            // Remap relative to original data
            let offset = end;
            let frame_start = frame.as_ptr() as usize - next_data.as_ptr() as usize;
            return Some(&data[offset + frame_start..offset + frame_start + frame.len()]);
        }
        return None;
    }

    Some(&data[soi..end])
}

/// Find a byte pattern in a slice.
fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Build an HTTP error response with binary body.
fn http_error_response(code: u16, body: &[u8]) -> Vec<u8> {
    let status = match code {
        400 => "400 Bad Request",
        502 => "502 Bad Gateway",
        _ => "500 Internal Server Error",
    };
    let resp = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        status, body.len()
    );
    let mut r = resp.into_bytes();
    r.extend_from_slice(body);
    r
}

/// Minimal percent-decoding for URL query parameters.
fn urlparse_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        match b {
            b'%' => {
                let h1 = chars.next().unwrap_or(b'0');
                let h2 = chars.next().unwrap_or(b'0');
                let hex = [h1, h2];
                let hex_str = std::str::from_utf8(&hex).unwrap_or("00");
                if let Ok(byte) = u8::from_str_radix(hex_str, 16) {
                    result.push(byte as char);
                }
            }
            b'+' => result.push(' '),
            _ => result.push(b as char),
        }
    }
    result
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

const DASH: &str = include_str!("dashboard.html");
const STYLE: &str = include_str!("style.css");
const SCRIPT: &str = include_str!("script.js");