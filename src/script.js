/**
 * @file script.js
 * @description World Monitor — client-side dashboard controller.
 *
 * Handles RSS feed scanning, local LLM interaction (via llama-server),
 * model management, budget tracking, and drill-down analysis.
 *
 * All API calls target the Rust backend running on the same origin.
 */

"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Color map for category accent dots in the headline list.
 * Keys must match the category names returned by the backend.
 * @type {Record<string, string>}
 */
const CATEGORY_COLORS = {
  "Geopolitics": "#4a9eff",
  "Tech & AI":   "#a78bfa",
  "Markets":     "#34d399",
  "Science":     "#fbbf24",
  "Security":    "#f87171",
  "Society":     "#fb923c",
};

/**
 * Maps llama-server status strings to UI presentation.
 * `badgeClass` is a CSS status utility class (see style.css).
 * @type {Record<string, {label: string, badgeClass: string, text: string}>}
 */
const STATUS_MAP = {
  ready:    { label: "AI ON",   badgeClass: "status-ready",   text: "Ready" },
  starting: { label: "LOADING", badgeClass: "status-warning", text: "Loading model..." },
  error:    { label: "ERROR",   badgeClass: "status-error",   text: "Error" },
  stopped:  { label: "OFF",     badgeClass: "status-off",     text: "Stopped" },
};

/**
 * Human-readable labels for drill-down analysis modes.
 * @type {Record<string, string>}
 */
const DRILL_MODE_LABELS = {
  "ai+page": "\u{1f916} AI + article",
  "ai":      "\u{1f916} AI analysis",
  "page":    "\u{1f4c4} Scraped (free)",
  "none":    "\u{26a0} Unavailable",
};

/** Reusable HTML for the three-dot loading animation. */
const LOADING_HTML =
  '<div class="ld"><span>\u25cf</span> <span>\u25cf</span> <span>\u25cf</span></div>';


// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

/** Whether the settings side-panel is currently visible. */
let settingsPanelOpen = false;

/**
 * Cached array of discovered model definitions from the server.
 * Populated by {@link loadModels} and read by {@link updateLlamaUI}.
 * @type {Array<ModelInfo>}
 */
let modelsCache = [];


// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS (JSDoc only — no runtime cost)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} ModelInfo
 * @property {string}  filename       - GGUF filename (e.g. "mistral-7b-q4.gguf")
 * @property {string}  name           - Human-readable display name
 * @property {string}  family         - Model family (e.g. "llama", "mistral")
 * @property {number}  ngl            - GPU layers
 * @property {number}  ctx            - Context window size
 * @property {boolean} flash_attn     - Flash-attention enabled
 * @property {number}  temp           - Temperature
 * @property {number}  top_k          - Top-K sampling
 * @property {number}  top_p          - Top-P (nucleus) sampling
 * @property {number}  repeat_penalty - Repetition penalty
 */

/**
 * @typedef {Object} UsageData
 * @property {number}  sess_tok       - Tokens used this session
 * @property {number}  day_tok        - Tokens used today
 * @property {number}  session_limit  - Session token cap (0 = unlimited)
 * @property {number}  daily_limit    - Daily token cap (0 = unlimited)
 * @property {boolean} has_ai         - Whether a model is loaded
 * @property {string}  model          - Active model filename
 * @property {number}  req_count      - Total AI requests this session
 * @property {number}  n_feeds        - Feeds that returned items on last scan
 * @property {number}  n_items        - Total items from last scan
 * @property {number|null} last_scan  - Unix timestamp of last scan (or null)
 */

/**
 * @typedef {Object} LlamaStatus
 * @property {string}  status     - "ready" | "starting" | "stopped" | "error"
 * @property {string}  [model]    - Loaded model filename
 * @property {number}  [ngl]      - GPU layers in use
 * @property {number}  [ctx]      - Context size in use
 * @property {boolean} [flash_attn] - Flash-attention flag
 * @property {number}  [pid]      - OS process ID
 * @property {string}  [error]    - Error message (when status === "error")
 */

/**
 * @typedef {Object} SamplingParams
 * @property {number} ngl            - GPU layers
 * @property {number} ctx            - Context size
 * @property {boolean} flash_attn    - Flash-attention
 * @property {number} temp           - Temperature
 * @property {number} top_k          - Top-K
 * @property {number} top_p          - Top-P
 * @property {number} repeat_penalty - Repeat penalty
 */


// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Escape a string for safe insertion into HTML content.
 * @param {string} s - Raw string.
 * @returns {string} HTML-escaped string.
 */
function escapeHtml(s) {
  return s
    ? String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
    : "";
}

/**
 * Escape a string for safe insertion into an HTML attribute (single-quoted).
 * Extends {@link escapeHtml} by also escaping apostrophes.
 * @param {string} s - Raw string.
 * @returns {string} Attribute-safe string.
 */
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

// Keep the short aliases used throughout the inline HTML builders.
const E = escapeHtml;
const A = escapeAttr;

/**
 * Format a millisecond duration for display (e.g. "340ms" or "2.1s").
 * @param {number} ms - Duration in milliseconds.
 * @returns {string} Formatted string.
 */
function fmtMs(ms) {
  return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
}

/**
 * Shorthand helper to get a DOM element by ID.
 * @param {string} id - Element ID.
 * @returns {HTMLElement}
 */
function $(id) {
  return document.getElementById(id);
}


// ═══════════════════════════════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Show a transient toast message at the bottom of the screen.
 * @param {string} message - Text to display.
 * @param {number} [durationMs=2500] - How long to keep it visible.
 */
function toast(message, durationMs = 2500) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("v");
  setTimeout(() => el.classList.remove("v"), durationMs);
}

/**
 * Briefly show an elapsed-time indicator in the top bar.
 * Auto-hides after 8 seconds.
 * @param {number} ms - Duration in milliseconds (falsy values are ignored).
 */
function showTime(ms) {
  if (!ms) return;
  const el = $("bt");
  el.textContent = fmtMs(ms);
  el.style.display = "inline";
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => (el.style.display = "none"), 8000);
}


// ═══════════════════════════════════════════════════════════════════════════════
// USAGE & BUDGET
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch the current usage stats from the server and update the UI.
 * Called after every AI request, scan, and on page load.
 * @returns {Promise<void>}
 */
async function fetchUsage() {
  try {
    const data = await (await fetch("/api/usage")).json();
    renderUsage(data);
  } catch (_) {
    /* Silently ignore — usage display is non-critical */
  }
}

/**
 * Render usage data into the top-bar budget meter and the settings stats panel.
 * @param {UsageData} d - Usage data from the server.
 */
function renderUsage(d) {
  const sessionLimit = d.session_limit || 0;
  const dailyLimit = d.daily_limit || 0;
  const sessionTokens = d.sess_tok || 0;
  const dayTokens = d.day_tok || 0;
  const hasAi = d.has_ai;

  // Compute percentage and label for the budget bar
  let pct = 0;
  let label = "";
  if (sessionLimit > 0) {
    pct = Math.min(100, (sessionTokens / sessionLimit) * 100);
    label = sessionTokens.toLocaleString() + "/" + sessionLimit.toLocaleString();
  } else if (dailyLimit > 0) {
    pct = Math.min(100, (dayTokens / dailyLimit) * 100);
    label = dayTokens.toLocaleString() + "/" + dailyLimit.toLocaleString();
  } else if (hasAi) {
    label = sessionTokens.toLocaleString() + " tok";
  } else {
    label = "Free";
  }

  $("bl").textContent = label;

  // Progress bar fill + color class
  const fill = $("bf");
  fill.style.width = sessionLimit > 0 || dailyLimit > 0 ? pct + "%" : "0%";
  fill.className = "fill" + (pct > 80 ? " d" : pct > 50 ? " w" : "");

  // Sync limit inputs in settings
  $("is").value = sessionLimit;
  $("id").value = dailyLimit;

  // Session stats summary (settings panel)
  $("ud").innerHTML =
    `Model: <b>${E(d.model || "none")}</b><br>` +
    `Tokens: <b>${sessionTokens.toLocaleString()}</b> sess / <b>${dayTokens.toLocaleString()}</b> day<br>` +
    `AI calls: ${d.req_count || 0}<br>` +
    `Feeds: ${d.n_feeds || 0} ok (${d.n_items || 0} items)<br>` +
    (d.last_scan
      ? "Last scan: " + new Date(d.last_scan * 1000).toLocaleTimeString()
      : "No scans");
}

/**
 * Save the budget limit inputs to the server.
 * @returns {Promise<void>}
 */
async function saveLimits() {
  const sessionLimit = parseInt($("is").value) || 0;
  const dailyLimit = parseInt($("id").value) || 0;
  try {
    const resp = await (
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_limit: sessionLimit, daily_limit: dailyLimit }),
      })
    ).json();
    if (resp.usage) renderUsage(resp.usage);
    toast("Limits saved");
  } catch (_) {
    toast("Error");
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// LLAMA SERVER STATUS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update all llama-server related UI elements — badge, status dot, detail
 * text, and load/stop button states.
 * @param {LlamaStatus} llama - Status object from the server (or locally constructed).
 */
function updateLlamaUI(llama) {
  const dot = $("ls-dot");
  const txt = $("ls-text");
  const det = $("ls-detail");
  const badge = $("badge");
  const btnLoad = $("btn-load");
  const btnStop = $("btn-stop");

  const status = llama.status || "stopped";
  const info = STATUS_MAP[status] || STATUS_MAP.stopped;

  // Status dot + text
  dot.className = "ls-dot " + status;
  txt.textContent = info.text;

  // Top-bar badge
  badge.textContent = info.label;
  badge.className = "badge label-caps " + info.badgeClass;

  // Detail line + button states depend on the specific status
  switch (status) {
    case "ready": {
      const match = modelsCache.find((m) => m.filename === llama.model);
      const name = match ? match.name : llama.model;
      det.textContent =
        name +
        " | ngl=" + llama.ngl +
        " ctx=" + llama.ctx +
        (llama.flash_attn ? " fa=on" : " fa=off") +
        (llama.pid ? " | PID " + llama.pid : "");
      btnLoad.disabled = false;
      btnStop.disabled = false;
      break;
    }
    case "starting":
      det.textContent = "Loading " + llama.model + "...";
      btnLoad.disabled = true;
      btnStop.disabled = false;
      break;
    case "error":
      det.textContent = llama.error || "Unknown error";
      btnLoad.disabled = false;
      btnStop.disabled = false;
      break;
    default: // stopped
      det.textContent = "\u2014";
      btnLoad.disabled = false;
      btnStop.disabled = true;
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// MODEL MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Populate a set of form inputs with a model's parameter defaults.
 * Used by both {@link loadModels} (server state) and {@link onModelPick} (user selection).
 * @param {Object} p - Parameter object with ngl, ctx, flash_attn, temp, top_k, top_p, repeat_penalty.
 */
function populateParamInputs(p) {
  $("cfg-ngl").value = p.ngl;
  $("cfg-ctx").value = p.ctx;
  $("cfg-fa").checked = p.flash_attn !== false;
  $("cfg-temp").value = Number(p.temp).toFixed(2);
  $("cfg-top_k").value = p.top_k;
  $("cfg-top_p").value = Number(p.top_p).toFixed(2);
  $("cfg-repeat_penalty").value = Number(p.repeat_penalty).toFixed(2);
}

/**
 * Fetch the model list and current server params, then render the model
 * selector dropdown and populate parameter inputs.
 * @returns {Promise<void>}
 */
async function loadModels() {
  try {
    const data = await (await fetch("/api/models")).json();
    modelsCache = data.models || [];

    const sel = $("cfg-model");
    sel.innerHTML = "";

    if (!modelsCache.length) {
      sel.innerHTML = '<option value="">(no models in models/ dir)</option>';
      return;
    }

    modelsCache.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.filename;
      opt.textContent = m.name + " [" + m.family + "]";
      if (m.filename === data.active) opt.selected = true;
      sel.appendChild(opt);
    });

    // Populate inputs from server state, or fall back to selected model defaults
    if (data.params) {
      populateParamInputs(data.params);
    } else {
      onModelPick();
    }

    if (data.llama) updateLlamaUI(data.llama);
  } catch (err) {
    console.error("loadModels", err);
  }
}

/**
 * Called when the user selects a different model in the dropdown.
 * Fills the parameter inputs with that model's configured defaults.
 */
function onModelPick() {
  const filename = $("cfg-model").value;
  const model = modelsCache.find((m) => m.filename === filename);
  if (model) populateParamInputs(model);
}

/**
 * Read the current values from all parameter inputs.
 * @returns {SamplingParams}
 */
function getParams() {
  return {
    ngl:            parseInt($("cfg-ngl").value) || 15,
    ctx:            parseInt($("cfg-ctx").value) || 4096,
    flash_attn:     $("cfg-fa").checked,
    temp:           parseFloat($("cfg-temp").value) || 0.7,
    top_k:          parseInt($("cfg-top_k").value) || 40,
    top_p:          parseFloat($("cfg-top_p").value) || 0.9,
    repeat_penalty: parseFloat($("cfg-repeat_penalty").value) || 1.1,
  };
}

/**
 * Request the backend to load (or reload) the selected model with the
 * current parameter inputs. Starts the llama-server process.
 * @returns {Promise<void>}
 */
async function loadModel() {
  const filename = $("cfg-model").value;
  if (!filename) {
    toast("No model selected");
    return;
  }

  const params = getParams();
  updateLlamaUI({ status: "starting", model: filename, ngl: params.ngl, ctx: params.ctx });
  toast("Loading model... (may take a minute)");

  try {
    const data = await (
      await fetch("/api/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: filename, ...params }),
      })
    ).json();

    if (data.error) {
      toast("Error: " + data.error);
      updateLlamaUI(data.llama || { status: "error", error: data.error });
    } else if (data.llama) {
      updateLlamaUI(data.llama);
      toast(data.ok ? "Model ready!" : "Model failed to start");
    }
    fetchUsage();
  } catch (err) {
    toast("Error: " + err.message);
    updateLlamaUI({ status: "error", error: err.message });
  }
}

/**
 * Request the backend to stop the running llama-server process.
 * @returns {Promise<void>}
 */
async function stopModel() {
  try {
    await fetch("/api/stop", { method: "POST" });
    updateLlamaUI({ status: "stopped" });
    toast("Model stopped");
    fetchUsage();
  } catch (err) {
    toast("Error: " + err.message);
  }
}

/**
 * Push the current sampling parameters (temp, top_k, top_p, repeat_penalty)
 * to the server. These apply on the next AI call — no model reload needed.
 * @returns {Promise<void>}
 */
async function saveParams() {
  const p = getParams();
  try {
    const data = await (
      await fetch("/api/params", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          temp: p.temp,
          top_k: p.top_k,
          top_p: p.top_p,
          repeat_penalty: p.repeat_penalty,
        }),
      })
    ).json();

    if (data.ok) {
      toast(
        "Params: temp=" + data.temp +
        " top_k=" + data.top_k +
        " top_p=" + data.top_p +
        " rp=" + data.repeat_penalty
      );
    } else {
      toast("Error saving params");
    }
  } catch (err) {
    toast("Error: " + err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS PANEL
// ═══════════════════════════════════════════════════════════════════════════════

/** Toggle the settings side-panel open/closed. */
function togSP() {
  settingsPanelOpen ? closeSP() : openSP();
}

/** Open the settings panel and refresh its data. */
function openSP() {
  settingsPanelOpen = true;
  $("sp").classList.add("open");
  $("spo").classList.add("open");
  fetchUsage();
  loadModels();
  loadDiag();
}

/** Close the settings panel. */
function closeSP() {
  settingsPanelOpen = false;
  $("sp").classList.remove("open");
  $("spo").classList.remove("open");
}


// ═══════════════════════════════════════════════════════════════════════════════
// FEED DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch per-feed diagnostic data and render it into the settings panel.
 * Each feed shows its name and last-fetch status (ok / fail).
 * @returns {Promise<void>}
 */
async function loadDiag() {
  try {
    const data = await (await fetch("/api/diag")).json();
    $("diag").innerHTML = data.length
      ? data
          .map((f) => {
            const ok = f.status.includes("items") && !f.status.includes("0 items");
            return (
              '<div class="diag-row">' +
              '<span class="diag-name">' + E(f.feed) + "</span>" +
              '<span class="' + (ok ? "diag-ok" : "diag-fail") + '">' +
              E(f.status) +
              "</span></div>"
            );
          })
          .join("")
      : "Run a scan first.";
  } catch (_) {
    /* non-critical */
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// RSS FEED SCANNING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Trigger an RSS feed scan on the backend and render the resulting headlines.
 * While scanning, shows a loading indicator and disables the scan button.
 * @returns {Promise<void>}
 */
async function scan() {
  const btn = $("sb");
  const container = $("hl");

  btn.disabled = true;
  btn.innerHTML = "&#x27f3; ...";
  container.innerHTML = LOADING_HTML + "<p>Fetching feeds...</p>";
  $("em").style.display = "none";

  try {
    const data = await (await fetch("/api/scan", { method: "POST" })).json();

    if (data.error) {
      container.innerHTML = '<div class="empty"><h2>Error</h2><p>' + data.error + "</p></div>";
      return;
    }

    const categories = data.headlines || [];
    const total = categories.reduce((n, c) => n + (c.items?.length || 0), 0);

    container.innerHTML = renderHeadlines(categories, total, data.ok, data.feeds);
    toast(total + " headlines from " + data.ok + " feeds");
    fetchUsage();
  } catch (err) {
    container.innerHTML =
      '<div class="empty"><h2>Error</h2><p>' + err.message + "</p></div>";
  } finally {
    btn.disabled = false;
    btn.innerHTML = "&#x27f3; Scan";
  }
}

/**
 * Build the full headlines HTML for all categories.
 * @param {Array}  categories - Array of {category, icon, items[]} from the server.
 * @param {number} total      - Total item count.
 * @param {number} okFeeds    - Number of feeds that returned items.
 * @param {number} totalFeeds - Total number of enabled feeds.
 * @returns {string} HTML string.
 */
function renderHeadlines(categories, total, okFeeds, totalFeeds) {
  const metaHtml =
    '<div class="meta"><span>' +
    okFeeds + "/" + totalFeeds + " feeds &middot; " + total + " headlines" +
    "</span><span>" + new Date().toLocaleTimeString() + "</span></div>";

  const catsHtml = categories
    .map(
      (cat) =>
        '<div class="cat">' +
        '<div class="ch">' +
        '<span class="ci">' + cat.icon + "</span>" +
        '<span class="ct label-caps">' + E(cat.category) + "</span>" +
        '<span class="cc">' + cat.items.length + "</span>" +
        "</div>" +
        cat.items.map((i) => renderItem(i, cat.category)).join("") +
        "</div>"
    )
    .join("");

  return metaHtml + catsHtml;
}

/**
 * Build the HTML for a single headline item row.
 * @param {Object} item     - Headline item {headline, summary, source, link, date}.
 * @param {string} category - Parent category name (for dot color).
 * @returns {string} HTML string.
 */
function renderItem(item, category) {
  const dotColor = CATEGORY_COLORS[category] || "var(--ac)";
  return (
    '<div class="it" onclick="drill(\'' + A(item.headline) + "','" + A(item.link || "") + "')\">" +
    '<div class="dot" style="background:' + dotColor + '"></div>' +
    '<div class="itx">' +
    '<div class="ih">' + E(item.headline) + "</div>" +
    '<div class="im">' +
    '<span class="is">' + E(item.source) + "</span>" +
    (item.date ? "<span>" + E(item.date.substring(0, 22)) + "</span>" : "") +
    "</div>" +
    (item.summary ? '<div class="isu">' + E(item.summary) + "</div>" : "") +
    "</div></div>"
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// AI ASK (query against loaded headlines)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fill the query input and immediately submit. Used by chip quick-actions.
 * @param {string} query    - Pre-filled question text.
 * @param {string} [category] - Optional category filter.
 */
function askQ(query, category) {
  $("qi").value = query;
  ask(category);
}

/**
 * Submit a natural-language question to the backend AI against the current
 * headline context. Shows the answer in the AI response panel.
 * @param {string} [category] - Optional category to filter context.
 * @returns {Promise<void>}
 */
async function ask(category) {
  const query = $("qi").value.trim();
  if (!query) {
    toast("Type a question first");
    return;
  }

  const panel = $("aip");
  const textEl = $("ait");
  const metaEl = $("aim");

  panel.classList.add("open");
  textEl.innerHTML = LOADING_HTML;
  metaEl.textContent = "";

  try {
    const payload = { query };
    if (category) payload.category = category;

    const data = await (
      await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    ).json();

    textEl.textContent = data.answer || data.error || "No response";

    // Build timing metadata line
    const parts = [];
    if (data.tokens) parts.push(data.tokens.toLocaleString() + " tokens");
    if (data.elapsed_ms) parts.push(fmtMs(data.elapsed_ms));
    metaEl.textContent = parts.join(" \u00b7 ") || "local";

    if (data.elapsed_ms) {
      toast(
        (data.tokens ? data.tokens.toLocaleString() + " tok \u00b7 " : "") +
        fmtMs(data.elapsed_ms)
      );
    }
    showTime(data.elapsed_ms);
    fetchUsage();
  } catch (err) {
    textEl.textContent = "Error: " + err.message;
  }
}

/** Close the AI response panel. */
function closeAI() {
  $("aip").classList.remove("open");
}


// ═══════════════════════════════════════════════════════════════════════════════
// DRILL-DOWN (deep-dive on a single headline)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Open the drill-down overlay and request an AI analysis of a headline.
 * If a link is available, the backend will try to scrape + summarize it.
 * @param {string} topic - Headline text.
 * @param {string} link  - Source URL (may be empty).
 * @returns {Promise<void>}
 */
async function drill(topic, link) {
  const overlay = $("ov");
  const content = $("drc");

  overlay.classList.add("open");
  content.innerHTML = LOADING_HTML;

  try {
    const data = await (
      await fetch("/api/drill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, link }),
      })
    ).json();

    if (data.error) {
      content.innerHTML = "<h2>Error</h2><p>" + data.error + "</p>";
      return;
    }

    content.innerHTML = renderDrill(data, topic, link);

    if (data.elapsed_ms) {
      toast(
        (data.tokens ? data.tokens.toLocaleString() + " tok \u00b7 " : "") +
        fmtMs(data.elapsed_ms)
      );
    }
    showTime(data.elapsed_ms);
    fetchUsage();
  } catch (err) {
    content.innerHTML = "<h2>Error</h2><p>" + err.message + "</p>";
  }
}

/**
 * Build the inner HTML for a drill-down result.
 * @param {Object} data  - API response {drill, mode, tokens, elapsed_ms}.
 * @param {string} topic - Original headline text (fallback title).
 * @param {string} link  - Source URL.
 * @returns {string} HTML string.
 */
function renderDrill(data, topic, link) {
  const info = data.drill || {};
  const modeLabel = DRILL_MODE_LABELS[data.mode] || data.mode;

  let html = "<h2>" + E(info.title || topic) + "</h2>";
  html += '<div class="det">' + E(info.detail || "") + "</div>";

  if (link) {
    html += '<a class="dl" href="' + E(link) + '" target="_blank">\u2192 Source</a>';
  }

  if (info.sources?.length) {
    html += '<div class="src">Sources: ' + info.sources.map(E).join(", ") + "</div>";
  }

  if (info.related?.length) {
    html +=
      '<div class="rel">' +
      info.related
        .map(
          (r) =>
            '<span class="rt" onclick="event.stopPropagation();closeDrill();drill(\'' +
            A(r) +
            "','')\">" +
            E(r) +
            "</span>"
        )
        .join("") +
      "</div>";
  }

  html +=
    '<div class="dm">' +
    modeLabel +
    " \u00b7 " +
    (data.tokens ? data.tokens.toLocaleString() + " tok" : "free") +
    (data.elapsed_ms ? " \u00b7 " + fmtMs(data.elapsed_ms) : "") +
    "</div>";

  return html;
}

/**
 * Close the drill-down overlay. When called from the overlay's own onclick,
 * only closes if the click target is the backdrop itself (not the content).
 * @param {MouseEvent} [event] - Click event (optional).
 */
function closeDrill(event) {
  if (!event || event.target.id === "ov") {
    $("ov").classList.remove("open");
  }
}

// Legacy alias — used by inline onclick in the HTML.
const cdrill = closeDrill;


// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bootstrap the dashboard on page load:
 *  1. Fetch current usage stats.
 *  2. Fetch model list + llama status for the top-bar badge.
 */
(async function init() {
  fetchUsage();

  try {
    const data = await (await fetch("/api/models")).json();
    modelsCache = data.models || [];
    if (data.llama) updateLlamaUI(data.llama);
  } catch (_) {
    /* Server may not be ready yet — badge stays "OFF" */
  }
})();
