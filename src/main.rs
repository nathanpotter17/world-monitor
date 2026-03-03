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

    let (cfg, can_ai, ready) = {
        let s = st.lock().unwrap();
        (s.cfg.clone(), s.usage.check(&s.cfg).is_ok(), s.llama.is_ready())
    };

    if !link.is_empty() {
        eprintln!("[drill] scraping {link}");
        if let Some(text) = scrape_page(&link, cfg.timeout) {
            if can_ai && ready {
                let max_chars = ((cfg.active_ctx as usize).saturating_sub(1500)) * 4;
                let text = trunc(&text, max_chars);
                let prompt = format!(
                    "Summarize this article titled \"{topic}\":\n\n{text}\n\nReturn JSON:\n{{\"title\":\"...\",\"detail\":\"2-3 paragraphs\",\"sources\":[\"...\"],\"related\":[\"...\"]}}"
                );

                if let Ok(r) = ai_call(&cfg, "Concise news analyst. JSON only, no markdown fences.", &prompt) {
                    st.lock().unwrap().usage.add(r.tokens);
                    return format!(
                        r#"{{"drill":{},"tokens":{},"elapsed_ms":{},"mode":"ai+page"}}"#,
                        jobj(&r.text),
                        r.tokens,
                        r.elapsed_ms
                    );
                }
            }

            return format!(
                r#"{{"drill":{{"title":"{}","detail":"{}","sources":["scraped"],"related":[]}},"tokens":0,"elapsed_ms":0,"mode":"page"}}"#,
                jval(&topic),
                jval(&trunc(&text, 2000))
            );
        }
    }

    if can_ai && ready {
        let prompt = format!(
            "Provide a brief analysis of: \"{topic}\". JSON only:\n{{\"title\":\"...\",\"detail\":\"2-3 paragraphs\",\"sources\":[],\"related\":[\"...\",\"...\"]}}"
        );

        if let Ok(r) = ai_call(&cfg, "News analyst. JSON only, no markdown fences.", &prompt) {
            st.lock().unwrap().usage.add(r.tokens);
            return format!(
                r#"{{"drill":{},"tokens":{},"elapsed_ms":{},"mode":"ai"}}"#,
                jobj(&r.text),
                r.tokens,
                r.elapsed_ms
            );
        }
    }

    let why = if !cfg.has_ai() {
        "No model loaded."
    } else if !ready {
        "Model still loading."
    } else {
        "Budget exhausted."
    };

    format!(
        r#"{{"drill":{{"title":"{}","detail":"{}","sources":[],"related":[]}},"tokens":0,"elapsed_ms":0,"mode":"none"}}"#,
        jval(&topic),
        jval(why)
    )
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
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

const DASH: &str = include_str!("dashboard.html");
const STYLE: &str = include_str!("style.css");
const SCRIPT: &str = include_str!("script.js");