/**
 * @file script.js
 * @description World Monitor — client-side dashboard controller.
 *
 * Handles NewsMonitor (RSS + AI), RTMonitor (cameras, flights, services),
 * model management, budget tracking, and drill-down analysis.
 */

"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const CATEGORY_COLORS = {
  "Geopolitics": "#4a9eff",
  "Tech & AI":   "#a78bfa",
  "Markets":     "#34d399",
  "Science":     "#fbbf24",
  "Security":    "#f87171",
  "Society":     "#fb923c",
};

const STATUS_MAP = {
  ready:    { label: "AI ON",   badgeClass: "status-ready",   text: "Ready" },
  starting: { label: "LOADING", badgeClass: "status-warning", text: "Loading model..." },
  error:    { label: "ERROR",   badgeClass: "status-error",   text: "Error" },
  stopped:  { label: "OFF",     badgeClass: "status-off",     text: "Stopped" },
};

const DRILL_MODE_LABELS = {
  "ai+page": "\u{1f916} AI + article",
  "ai":      "\u{1f916} AI analysis",
  "page":    "\u{1f4c4} Scraped (free)",
  "none":    "\u{26a0} Unavailable",
};

const LOADING_HTML =
  '<div class="ld"><span>\u25cf</span> <span>\u25cf</span> <span>\u25cf</span></div>';

const CAM_CAT_LABELS = {
  traffic: "Traffic",
  weather: "Weather",
  public:  "Webcam",
  other:   "Other",
};


// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let settingsPanelOpen = false;
let modelsCache = [];
let activeTab = "news";

// RT Monitor state
let rtCameras = [];
let rtFlights = [];
let rtServices = [];
let rtCamTimers = {};
let rtSvcTimers = {};
let rtLogEntries = [];


// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function escapeHtml(s) {
  return s
    ? String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
    : "";
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

const E = escapeHtml;
const A = escapeAttr;

function fmtMs(ms) {
  return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
}

function $(id) {
  return document.getElementById(id);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function ts() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}


// ═══════════════════════════════════════════════════════════════════════════════
// TOAST / TIMING
// ═══════════════════════════════════════════════════════════════════════════════

function toast(message, durationMs = 2500) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("v");
  setTimeout(() => el.classList.remove("v"), durationMs);
}

function showTime(ms) {
  if (!ms) return;
  const el = $("bt");
  el.textContent = fmtMs(ms);
  el.style.display = "inline";
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => (el.style.display = "none"), 8000);
}


// ═══════════════════════════════════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════════════════════════════════

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
  $("tab-" + tab).classList.add("active");
  $("tc-" + tab).classList.add("active");
}


// ═══════════════════════════════════════════════════════════════════════════════
// USAGE & BUDGET
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchUsage() {
  try {
    const data = await (await fetch("/api/usage")).json();
    renderUsage(data);
  } catch (_) {}
}

function renderUsage(d) {
  const sessionLimit = d.session_limit || 0;
  const dailyLimit = d.daily_limit || 0;
  const sessionTokens = d.sess_tok || 0;
  const dayTokens = d.day_tok || 0;
  const hasAi = d.has_ai;

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

  const fill = $("bf");
  fill.style.width = sessionLimit > 0 || dailyLimit > 0 ? pct + "%" : "0%";
  fill.className = "fill" + (pct > 80 ? " d" : pct > 50 ? " w" : "");

  $("is").value = sessionLimit;
  $("id").value = dailyLimit;

  $("ud").innerHTML =
    `Model: <b>${E(d.model || "none")}</b><br>` +
    `Tokens: <b>${sessionTokens.toLocaleString()}</b> sess / <b>${dayTokens.toLocaleString()}</b> day<br>` +
    `AI calls: ${d.req_count || 0}<br>` +
    `Feeds: ${d.n_feeds || 0} ok (${d.n_items || 0} items)<br>` +
    (d.last_scan
      ? "Last scan: " + new Date(d.last_scan * 1000).toLocaleTimeString()
      : "No scans");
}

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

function updateLlamaUI(llama) {
  const dot = $("ls-dot");
  const txt = $("ls-text");
  const det = $("ls-detail");
  const badge = $("badge");
  const btnLoad = $("btn-load");
  const btnStop = $("btn-stop");

  const status = llama.status || "stopped";
  const info = STATUS_MAP[status] || STATUS_MAP.stopped;

  dot.className = "ls-dot " + status;
  txt.textContent = info.text;

  badge.textContent = info.label;
  badge.className = "badge label-caps " + info.badgeClass;

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
    default:
      det.textContent = "\u2014";
      btnLoad.disabled = false;
      btnStop.disabled = true;
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// MODEL MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

function populateParamInputs(p) {
  $("cfg-ngl").value = p.ngl;
  $("cfg-ctx").value = p.ctx;
  $("cfg-fa").checked = p.flash_attn !== false;
  $("cfg-temp").value = Number(p.temp).toFixed(2);
  $("cfg-top_k").value = p.top_k;
  $("cfg-top_p").value = Number(p.top_p).toFixed(2);
  $("cfg-repeat_penalty").value = Number(p.repeat_penalty).toFixed(2);
}

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

function onModelPick() {
  const filename = $("cfg-model").value;
  const model = modelsCache.find((m) => m.filename === filename);
  if (model) populateParamInputs(model);
}

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

async function loadModel() {
  const filename = $("cfg-model").value;
  if (!filename) { toast("No model selected"); return; }

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
      toast("Params: temp=" + data.temp + " top_k=" + data.top_k + " top_p=" + data.top_p + " rp=" + data.repeat_penalty);
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

function togSP() { settingsPanelOpen ? closeSP() : openSP(); }

function openSP() {
  settingsPanelOpen = true;
  $("sp").classList.add("open");
  $("spo").classList.add("open");
  fetchUsage();
  loadModels();
  loadDiag();
}

function closeSP() {
  settingsPanelOpen = false;
  $("sp").classList.remove("open");
  $("spo").classList.remove("open");
}


// ═══════════════════════════════════════════════════════════════════════════════
// FEED DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════════════════

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
              E(f.status) + "</span></div>"
            );
          })
          .join("")
      : "Run a scan first.";
  } catch (_) {}
}


// ═══════════════════════════════════════════════════════════════════════════════
// RSS FEED SCANNING (NewsMonitor)
// ═══════════════════════════════════════════════════════════════════════════════

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
    container.innerHTML = '<div class="empty"><h2>Error</h2><p>' + err.message + "</p></div>";
  } finally {
    btn.disabled = false;
    btn.innerHTML = "&#x27f3; Scan";
  }
}

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
// AI ASK (NewsMonitor)
// ═══════════════════════════════════════════════════════════════════════════════

function askQ(query, category) {
  $("qi").value = query;
  ask(category);
}

async function ask(category) {
  const query = $("qi").value.trim();
  if (!query) { toast("Type a question first"); return; }

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

    const parts = [];
    if (data.tokens) parts.push(data.tokens.toLocaleString() + " tokens");
    if (data.elapsed_ms) parts.push(fmtMs(data.elapsed_ms));
    metaEl.textContent = parts.join(" \u00b7 ") || "local";

    if (data.elapsed_ms) {
      toast((data.tokens ? data.tokens.toLocaleString() + " tok \u00b7 " : "") + fmtMs(data.elapsed_ms));
    }
    showTime(data.elapsed_ms);
    fetchUsage();
  } catch (err) {
    textEl.textContent = "Error: " + err.message;
  }
}

function closeAI() { $("aip").classList.remove("open"); }


// ═══════════════════════════════════════════════════════════════════════════════
// DRILL-DOWN (NewsMonitor) — curl-first, AI on demand
// ═══════════════════════════════════════════════════════════════════════════════

/** Stashed drill state for the AI summary button to use */
let _drillTopic = "";
let _drillText = "";

async function drill(topic, link) {
  const overlay = $("ov");
  const content = $("drc");

  _drillTopic = topic;
  _drillText = "";

  overlay.classList.add("open");
  content.innerHTML = LOADING_HTML + "<p>Fetching article via curl...</p>";

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

    _drillText = data.scraped_text || "";
    content.innerHTML = renderDrill(data, topic, link);

    if (data.elapsed_ms) toast("Fetched in " + fmtMs(data.elapsed_ms));
  } catch (err) {
    content.innerHTML = "<h2>Error</h2><p>" + err.message + "</p>";
  }
}

function renderDrill(data, topic, link) {
  const info = data.drill || {};

  let html = "<h2>" + E(info.title || topic) + "</h2>";

  // Source link
  if (link) {
    html += '<a class="dl" href="' + E(link) + '" target="_blank">\u2192 Source</a>';
  }

  // AI Summary button — always shown
  html += '<div style="margin:12px 0">';
  html += '<button class="pri" id="drill-ai-btn" onclick="drillAI()" style="font-size:13px;padding:8px 18px">';
  html += '\ud83e\udde0 AI Summary</button>';
  html += '<span id="drill-ai-status" style="margin-left:10px;font-size:11px;color:var(--tx2)"></span>';
  html += '</div>';

  // AI result placeholder
  html += '<div id="drill-ai-result"></div>';

  // Scraped text section
  if (info.detail && data.mode === "page") {
    html += '<div class="drill-scraped">';
    html += '<div class="drill-scraped-label label-caps">Scraped Content</div>';
    html += '<div class="drill-scraped-text">' + E(info.detail) + '</div>';
    html += '</div>';
  } else if (data.mode === "none") {
    html += '<div class="drill-scraped">';
    html += '<div class="drill-scraped-text" style="color:var(--tx2);font-style:italic">' +
      'Could not fetch article. AI Summary will analyze the headline only.</div>';
    html += '</div>';
  }

  // Meta
  html += '<div class="dm">curl \u00b7 ' +
    (data.elapsed_ms ? fmtMs(data.elapsed_ms) : "cached") + '</div>';

  return html;
}

/** On-demand AI summary — called from drill overlay button */
async function drillAI() {
  const btn = $("drill-ai-btn");
  const status = $("drill-ai-status");
  const result = $("drill-ai-result");

  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "\u23f3 Analyzing...";
  status.textContent = "";
  result.innerHTML = LOADING_HTML;

  try {
    const data = await (
      await fetch("/api/drill/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: _drillTopic, text: _drillText }),
      })
    ).json();

    if (data.error) {
      result.innerHTML = '<div style="color:var(--rd)">' + E(data.error) + '</div>';
      btn.textContent = "\ud83e\udde0 AI Summary";
      btn.disabled = false;
      return;
    }

    const ai = data.ai || {};
    let html = '<div class="drill-ai-box">';
    html += '<div class="drill-ai-label label-caps">\ud83e\udde0 AI Analysis</div>';
    if (ai.summary) {
      html += '<div class="drill-ai-text">' + E(ai.summary) + '</div>';
    }
    if (ai.key_points && ai.key_points.length) {
      html += '<div class="drill-ai-points">';
      ai.key_points.forEach(function(p) {
        html += '<div class="drill-ai-point">\u2022 ' + E(p) + '</div>';
      });
      html += '</div>';
    }
    if (ai.related && ai.related.length) {
      html += '<div class="rel">';
      ai.related.forEach(function(r) {
        html += '<span class="rt" onclick="event.stopPropagation();closeDrill();drill(\'' +
          A(r) + "','')\">" + E(r) + "</span>";
      });
      html += '</div>';
    }
    html += '</div>';
    result.innerHTML = html;

    const parts = [];
    if (data.tokens) parts.push(data.tokens.toLocaleString() + " tok");
    if (data.elapsed_ms) parts.push(fmtMs(data.elapsed_ms));
    status.textContent = parts.join(" \u00b7 ");

    btn.textContent = "\u2713 AI Summary";
    btn.disabled = true;

    if (data.elapsed_ms) toast((data.tokens ? data.tokens.toLocaleString() + " tok \u00b7 " : "") + fmtMs(data.elapsed_ms));
    showTime(data.elapsed_ms);
    fetchUsage();
  } catch (err) {
    result.innerHTML = '<div style="color:var(--rd)">Error: ' + E(err.message) + '</div>';
    btn.textContent = "\ud83e\udde0 AI Summary";
    btn.disabled = false;
  }
}

function closeDrill(event) {
  if (!event || event.target.id === "ov") {
    $("ov").classList.remove("open");
  }
}
const cdrill = closeDrill;


// ═══════════════════════════════════════════════════════════════════════════════
//  RT MONITOR — ACTIVITY LOG
// ═══════════════════════════════════════════════════════════════════════════════

function rtLog(msg, level = "info") {
  const entry = { ts: ts(), msg, level };
  rtLogEntries.push(entry);
  if (rtLogEntries.length > 200) rtLogEntries.shift();

  const el = $("rt-log");
  const div = document.createElement("div");
  div.className = "rt-log-entry rt-log-" + level;
  div.innerHTML = '<span class="rt-log-ts">' + E(entry.ts) + "</span><span>" + E(msg) + "</span>";
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function clearRtLog() {
  rtLogEntries = [];
  $("rt-log").innerHTML = '<div class="rt-log-entry rt-log-sys">Log cleared.</div>';
}


// ═══════════════════════════════════════════════════════════════════════════════
//  RT MONITOR — AI ASK
// ═══════════════════════════════════════════════════════════════════════════════

function rtAskQ(query) {
  $("rt-qi").value = query;
  rtAsk();
}

async function rtAsk() {
  const query = $("rt-qi").value.trim();
  if (!query) { toast("Type a question first"); return; }

  const panel = $("rt-aip");
  const textEl = $("rt-ait");
  const metaEl = $("rt-aim");
  const label = $("rt-ai-label");

  panel.classList.add("open");
  if (label) label.innerHTML = '<span>\ud83e\udd16 AI Response</span><button class="ai-close btn-ghost" onclick="closeRtAI()">&times;</button>';
  textEl.innerHTML = LOADING_HTML;
  metaEl.textContent = "";

  // Build context from RT state
  let ctx = "RT Monitor state:\n";
  ctx += "Cameras (" + rtCameras.length + "): " + rtCameras.map((c) => c.name + " [" + c.cat + "] " + c.url).join("; ") + "\n";
  ctx += "Flights (" + rtFlights.length + "): " + rtFlights.map((f) => f.callsign + " [" + f.source + "] " + f.status).join("; ") + "\n";
  ctx += "Services (" + rtServices.length + "): " + rtServices.map((s) => s.name + " " + s.url + " [" + s.status + "]").join("; ") + "\n";

  try {
    const data = await (
      await fetch("/api/rt/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, context: ctx }),
      })
    ).json();

    textEl.textContent = data.answer || data.error || "No response";

    const parts = [];
    if (data.tokens) parts.push(data.tokens.toLocaleString() + " tokens");
    if (data.elapsed_ms) parts.push(fmtMs(data.elapsed_ms));
    metaEl.textContent = parts.join(" \u00b7 ") || "local";

    if (data.elapsed_ms) {
      toast((data.tokens ? data.tokens.toLocaleString() + " tok \u00b7 " : "") + fmtMs(data.elapsed_ms));
    }
    showTime(data.elapsed_ms);
    fetchUsage();
    rtLog("AI query: " + query.substring(0, 60), "info");
  } catch (err) {
    textEl.textContent = "Error: " + err.message;
    rtLog("AI error: " + err.message, "err");
  }
}

function closeRtAI() { $("rt-aip").classList.remove("open"); }


// ═══════════════════════════════════════════════════════════════════════════════
//  RT MONITOR — DISCOVERY CRAWLER
// ═══════════════════════════════════════════════════════════════════════════════

/** Running discovery scan state */
let discoveryRunning = false;

/**
 * Run the automated discovery crawler. The backend curls known public DOT
 * camera APIs, OpenSky flights, and probes known endpoints.
 * Results are displayed with [Add] buttons to import into the local state.
 * @param {string} type - "cameras", "flights", or "all"
 */
async function runDiscovery(dtype) {
  if (discoveryRunning) { toast("Discovery already running..."); return; }
  discoveryRunning = true;

  const panel = $("rt-aip");
  const textEl = $("rt-ait");
  const metaEl = $("rt-aim");
  const label = $("rt-ai-label");

  panel.classList.add("open");
  if (label) label.innerHTML = '<span>\ud83d\udd0d Discovery Crawler</span><button class="ai-close btn-ghost" onclick="closeRtAI()">&times;</button>';
  textEl.innerHTML = LOADING_HTML + '<p>Crawling public data sources for ' + E(dtype) + '...<br>This may take 15\u201330 seconds.</p>';
  metaEl.textContent = "";

  rtLog("Discovery started: " + dtype, "sys");

  try {
    const data = await (
      await fetch("/api/rt/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: dtype }),
      })
    ).json();

    if (data.error) {
      textEl.textContent = "Error: " + data.error;
      rtLog("Discovery error: " + data.error, "err");
      discoveryRunning = false;
      return;
    }

    // Render results
    let html = "";

    // Log entries (collapsed by default if many results)
    if (data.log && data.log.length) {
      html += '<details class="disc-details"><summary class="disc-summary">\ud83d\udcdd Crawl Log (' + data.log.length + ' entries)</summary>';
      html += '<div class="disc-log">';
      data.log.forEach(function(l) {
        html += '<div class="disc-log-line">' + E(l) + '</div>';
      });
      html += '</div></details>';
    }

    // Cameras found — grouped by source
    const cams = data.cameras || [];
    if (cams.length) {
      // Group by source
      const groups = {};
      cams.forEach(function(cam, i) {
        cam._idx = i; // preserve global index
        const src = cam.source || "Unknown";
        if (!groups[src]) groups[src] = [];
        groups[src].push(cam);
      });

      const sourceNames = Object.keys(groups).sort(function(a, b) {
        return groups[b].length - groups[a].length; // largest first
      });

      html += '<div class="disc-section">';
      html += '<div class="disc-section-head">';
      html += '\ud83d\udcf7 <b>' + cams.length + ' Cameras Found</b> from ' + sourceNames.length + ' sources';
      html += '<span style="margin-left:auto;display:flex;gap:6px">';
      html += '<button class="pri" onclick="discoverAddBatchCams(10)" style="font-size:10px;padding:2px 8px">+ Add 10</button>';
      html += '<button class="pri" onclick="discoverAddBatchCams(50)" style="font-size:10px;padding:2px 8px">+ Add 50</button>';
      html += '<button class="pri" onclick="discoverAddAllCams()" style="font-size:10px;padding:2px 8px">+ Add All</button>';
      html += '</span></div>';

      sourceNames.forEach(function(src) {
        const srcCams = groups[src];
        const isLarge = srcCams.length > 10;
        html += '<details class="disc-details"' + (srcCams.length <= 20 ? ' open' : '') + '>';
        html += '<summary class="disc-summary">' + E(src) + ' \u00b7 ' + srcCams.length + ' cameras';
        html += '<button onclick="event.stopPropagation();discoverAddSourceCams(\'' + A(src) + '\')" class="disc-add-btn" style="margin-left:auto;font-size:10px">+ Add Group</button>';
        html += '</summary><div class="disc-items-wrap">';
        srcCams.forEach(function(cam) {
          const isDupe = rtCameras.some(function(c) { return c.url === cam.url; });
          html += '<div class="disc-item' + (isDupe ? ' disc-dupe' : '') + '" data-disc-idx="' + cam._idx + '" data-disc-cam="' + cam._idx + '">';
          html += '<span class="disc-item-name">' + E(cam.name || ("Camera " + (cam._idx + 1))) + '</span>';
          html += '<span class="disc-item-detail">' + E(cam.type || "image") + (cam.cat ? ' \u00b7 ' + E(cam.cat) : '') + '</span>';
          html += '<button onclick="discoverAddCam(' + cam._idx + ')" class="disc-add-btn">+ Add</button>';
          html += '</div>';
        });
        html += '</div></details>';
      });
      html += '</div>';
    }

    // Flights found
    const flights = data.flights || [];
    if (flights.length) {
      html += '<div class="disc-section">';
      html += '<div class="disc-section-head">\u2708\ufe0f <b>' + flights.length + ' Flights</b>';
      html += '<span style="margin-left:auto;display:flex;gap:6px">';
      html += '<button class="pri" onclick="discoverAddBatchFlights(10)" style="font-size:10px;padding:2px 8px">+ Track 10</button>';
      html += '<button class="pri" onclick="discoverAddAllFlights()" style="font-size:10px;padding:2px 8px">+ Track All</button>';
      html += '</span></div>';
      flights.forEach(function(f, i) {
        const detail = (f.origin || "??") + " \u00b7 alt " + Math.round(f.alt || 0) + "m \u00b7 " + Math.round(f.velocity || 0) + "m/s";
        const isDupe = rtFlights.some(function(x) { return x.callsign === f.callsign; });
        html += '<div class="disc-item' + (isDupe ? ' disc-dupe' : '') + '" data-disc-idx="' + i + '" data-disc-flt="' + i + '">';
        html += '<span class="disc-item-name">' + E(f.callsign) + '</span>';
        html += '<span class="disc-item-detail">' + E(detail) + '</span>';
        html += '<button onclick="discoverAddFlight(' + i + ')" class="disc-add-btn">+ Track</button>';
        html += '</div>';
      });
      html += '</div>';
    }

    if (!cams.length && !flights.length) {
      html += '<div style="color:var(--tx2);margin-top:12px">No feeds discovered. Sources may be temporarily unavailable.</div>';
    }

    textEl.innerHTML = html;
    metaEl.textContent = (cams.length || 0) + " cameras \u00b7 " + (flights.length || 0) + " flights";

    // Stash results for add buttons
    window._discCams = cams;
    window._discFlights = flights;

    rtLog("Discovery complete: " + cams.length + " cameras, " + flights.length + " flights", "ok");
    toast("Found " + cams.length + " cameras, " + flights.length + " flights");
  } catch (err) {
    textEl.textContent = "Discovery failed: " + err.message;
    rtLog("Discovery failed: " + err.message, "err");
  }

  discoveryRunning = false;
}

/** Add a single discovered camera */
function discoverAddCam(index) {
  const cam = (window._discCams || [])[index];
  if (!cam) return;

  // Check if already added
  if (rtCameras.some(c => c.url === cam.url)) {
    toast("Already added: " + (cam.name || cam.url));
    return;
  }

  const newCam = {
    id: uid(),
    name: cam.name || "Discovered Cam",
    url: cam.url,
    type: cam.type || "image",
    refresh: cam.type === "mjpeg" ? 5 : cam.type === "iframe" ? 0 : 15,
    cat: cam.cat || "traffic",
    source: cam.source || "",
    region: cam.region || "",
    status: "ok"
  };
  rtCameras.push(newCam);
  renderCams();
  startCamRefresh(newCam);
  saveCamsToServer();
  rtLog("Added camera: " + newCam.name, "ok");
  toast("Added: " + newCam.name);

  // Update the add button to show checkmark
  refreshDiscoveryDupeState();
}

/** Add first N discovered cameras (not already added) */
function discoverAddBatchCams(n) {
  const cams = window._discCams || [];
  let added = 0;
  for (let i = 0; i < cams.length && added < n; i++) {
    const cam = cams[i];
    if (rtCameras.some(c => c.url === cam.url)) continue;
    rtCameras.push({
      id: uid(),
      name: cam.name || "Discovered Cam",
      url: cam.url,
      type: cam.type || "image",
      refresh: cam.type === "mjpeg" ? 5 : cam.type === "iframe" ? 0 : 15,
      cat: cam.cat || "traffic",
      source: cam.source || "",
      region: cam.region || "",
      status: "ok"
    });
    added++;
  }
  if (added > 0) {
    renderCams();
    rtCameras.forEach(startCamRefresh);
    saveCamsToServer();
    refreshDiscoveryDupeState();
  }
  rtLog("Batch-added " + added + " cameras", "ok");
  toast("Added " + added + " cameras");
}

/** Add all cameras from a specific source group */
function discoverAddSourceCams(source) {
  const cams = (window._discCams || []).filter(function(c) { return c.source === source; });
  let added = 0;
  cams.forEach(function(cam) {
    if (rtCameras.some(c => c.url === cam.url)) return;
    rtCameras.push({
      id: uid(),
      name: cam.name || "Discovered Cam",
      url: cam.url,
      type: cam.type || "image",
      refresh: cam.type === "mjpeg" ? 5 : cam.type === "iframe" ? 0 : 15,
      cat: cam.cat || "traffic",
      source: cam.source || "",
      region: cam.region || "",
      status: "ok"
    });
    added++;
  });
  if (added > 0) {
    renderCams();
    rtCameras.forEach(startCamRefresh);
    saveCamsToServer();
    refreshDiscoveryDupeState();
  }
  rtLog("Added " + added + " cameras from " + source, "ok");
  toast("Added " + added + " from " + source);
}

/** Add ALL discovered cameras */
function discoverAddAllCams() {
  const cams = window._discCams || [];
  let added = 0;
  cams.forEach(function(cam) {
    if (rtCameras.some(c => c.url === cam.url)) return;
    rtCameras.push({
      id: uid(),
      name: cam.name || "Discovered Cam",
      url: cam.url,
      type: cam.type || "image",
      refresh: cam.type === "mjpeg" ? 5 : cam.type === "iframe" ? 0 : 15,
      cat: cam.cat || "traffic",
      source: cam.source || "",
      region: cam.region || "",
      status: "ok"
    });
    added++;
  });
  if (added > 0) {
    renderCams();
    rtCameras.forEach(startCamRefresh);
    saveCamsToServer();
    refreshDiscoveryDupeState();
  }
  rtLog("Added " + added + " cameras from discovery", "ok");
  toast("Added " + added + " cameras");
}

/** Add a single discovered flight */
function discoverAddFlight(index) {
  const f = (window._discFlights || [])[index];
  if (!f) return;

  if (rtFlights.some(fl => fl.callsign === f.callsign)) {
    toast("Already tracking: " + f.callsign);
    return;
  }

  const flight = {
    id: uid(),
    callsign: f.callsign,
    source: "opensky",
    notes: f.origin + " | alt=" + Math.round(f.alt || 0) + "m",
    status: "tracked",
    lastCheck: ts(),
    position: f.lat.toFixed(4) + ", " + f.lng.toFixed(4),
    altitude: f.alt,
    velocity: f.velocity,
    origin: f.origin,
    on_ground: false
  };
  rtFlights.push(flight);
  renderFlights();
  saveFlightsToServer();
  rtLog("Tracking flight: " + f.callsign, "ok");
  toast("Tracking: " + f.callsign);
  refreshDiscoveryDupeState();
}

/** Add first N discovered flights (not already tracked) */
function discoverAddBatchFlights(n) {
  const flights = window._discFlights || [];
  let added = 0;
  for (let i = 0; i < flights.length && added < n; i++) {
    const f = flights[i];
    if (rtFlights.some(fl => fl.callsign === f.callsign)) continue;
    rtFlights.push({
      id: uid(),
      callsign: f.callsign,
      source: "opensky",
      notes: f.origin,
      status: "tracked",
      lastCheck: ts(),
      altitude: f.alt,
      velocity: f.velocity,
      origin: f.origin,
      on_ground: false
    });
    added++;
  }
  if (added > 0) {
    renderFlights();
    saveFlightsToServer();
    refreshDiscoveryDupeState();
  }
  rtLog("Batch-tracked " + added + " flights", "ok");
  toast("Tracking " + added + " flights");
}

/** Add all discovered flights */
function discoverAddAllFlights() {
  const flights = window._discFlights || [];
  let added = 0;
  flights.forEach(function(f) {
    if (rtFlights.some(fl => fl.callsign === f.callsign)) return;
    rtFlights.push({
      id: uid(),
      callsign: f.callsign,
      source: "opensky",
      notes: f.origin,
      status: "tracked",
      lastCheck: ts(),
      altitude: f.alt,
      velocity: f.velocity,
      origin: f.origin,
      on_ground: false
    });
    added++;
  });
  if (added > 0) {
    renderFlights();
    saveFlightsToServer();
    refreshDiscoveryDupeState();
  }
  rtLog("Added " + added + " flights from discovery", "ok");
  toast("Tracking " + added + " flights");
}

/** Refresh the discovery panel to show/hide dupe state after adds/removes.
 *  Non-destructive: uses CSS classes and data attributes, never replaces buttons. */
function refreshDiscoveryDupeState() {
  const items = document.querySelectorAll(".disc-item[data-disc-idx]");
  items.forEach(function(el) {
    const camIdx = el.getAttribute("data-disc-cam");
    const fltIdx = el.getAttribute("data-disc-flt");
    let isDupe = false;

    if (camIdx !== null) {
      const cam = (window._discCams || [])[parseInt(camIdx)];
      if (cam) isDupe = rtCameras.some(function(c) { return c.url === cam.url; });
    }
    if (fltIdx !== null) {
      const f = (window._discFlights || [])[parseInt(fltIdx)];
      if (f) isDupe = rtFlights.some(function(x) { return x.callsign === f.callsign; });
    }

    if (isDupe) {
      el.classList.add("disc-dupe");
    } else {
      el.classList.remove("disc-dupe");
    }
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
//  RT MONITOR — CAMERA FEEDS
// ═══════════════════════════════════════════════════════════════════════════════

function openAddCam() { $("cam-modal").classList.add("open"); }

async function addCam() {
  const name = $("cam-name").value.trim();
  const url = $("cam-url").value.trim();
  const type = $("cam-type").value;
  const refresh = parseInt($("cam-refresh").value) || 10;
  const cat = $("cam-cat").value;

  if (!name || !url) { toast("Name and URL required"); return; }

  toast("Validating feed...");

  let validated = false;
  try {
    const check = await (
      await fetch("/api/rt/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, method: "http" }),
      })
    ).json();

    if (check.image_valid) {
      validated = true;
      rtLog("Camera validated: " + name + " — real image " + (check.size || "") + " (HTTP " + (check.http_code || "ok") + ")", "ok");
    } else if (check.up) {
      rtLog("Camera reachable but unverified: " + name + " — " + (check.detail || "unknown") + " (adding anyway)", "warn");
    } else {
      rtLog("Camera unreachable: " + name + " — " + (check.detail || "failed") + " (adding anyway)", "warn");
    }
  } catch (_) {
    rtLog("Could not validate " + name + " (adding anyway)", "warn");
  }

  const cam = { id: uid(), name, url, type, refresh, cat, status: validated ? "ok" : "unverified" };
  rtCameras.push(cam);

  closeModal("cam-modal");
  $("cam-name").value = "";
  $("cam-url").value = "";
  $("cam-refresh").value = "10";

  renderCams();
  startCamRefresh(cam);
  rtLog("Camera added: " + name, "ok");
  saveCamsToServer();
}

function removeCam(id) {
  if (rtCamTimers[id]) { clearInterval(rtCamTimers[id]); delete rtCamTimers[id]; }
  const cam = rtCameras.find((c) => c.id === id);
  rtCameras = rtCameras.filter((c) => c.id !== id);
  renderCams();
  if (cam) rtLog("Camera removed: " + cam.name, "warn");
  saveCamsToServer();
  refreshDiscoveryDupeState();
}

function removeAllCams() {
  if (!rtCameras.length) { toast("No cameras to remove"); return; }
  if (!confirm("Remove all " + rtCameras.length + " cameras?")) return;
  Object.keys(rtCamTimers).forEach(function(id) { clearInterval(rtCamTimers[id]); });
  rtCamTimers = {};
  const count = rtCameras.length;
  rtCameras = [];
  renderCams();
  saveCamsToServer();
  refreshDiscoveryDupeState();
  rtLog("Removed all " + count + " cameras", "warn");
  toast("Removed " + count + " cameras");
}

function startCamRefresh(cam) {
  // Skip iframes (YouTube embeds) and cameras with no refresh interval
  if (cam.type === "iframe" || !cam.refresh) return;
  const interval = cam.type === "mjpeg" ? Math.max(cam.refresh, 3) : Math.max(cam.refresh, 10);
  rtCamTimers[cam.id] = setInterval(() => {
      const img = document.querySelector(`[data-cam-id="${cam.id}"] img`);
      if (img) {
        img.src = "/api/rt/cam/proxy?url=" + encodeURIComponent(cam.url) + "&_t=" + Date.now();
      }
    }, interval * 1000);
}

function refreshAllCams() {
  rtCameras.forEach((cam) => {
    if (cam.type !== "iframe") {
      const img = document.querySelector(`[data-cam-id="${cam.id}"] img`);
      if (img) {
        img.src = "/api/rt/cam/proxy?url=" + encodeURIComponent(cam.url) + "&_t=" + Date.now();
      }
    }
  });
  rtLog("All cameras refreshed", "info");
  toast("Cameras refreshed");
}

function renderCams() {
  const grid = $("cam-grid");
  $("cam-count").textContent = rtCameras.length;

  // Populate filter dropdowns dynamically
  const srcSet = new Set();
  const regSet = new Set();
  rtCameras.forEach(c => {
    if (c.source) srcSet.add(c.source);
    if (c.region) regSet.add(c.region);
  });
  const srcSel = $("cam-filter-source");
  const regSel = $("cam-filter-region");
  if (srcSel) {
    const cur = srcSel.value;
    srcSel.innerHTML = '<option value="">All Sources</option>' +
      [...srcSet].sort().map(s => '<option value="' + E(s) + '"' + (s === cur ? ' selected' : '') + '>' + E(s) + '</option>').join('');
  }
  if (regSel) {
    const cur = regSel.value;
    regSel.innerHTML = '<option value="">All Regions</option>' +
      [...regSet].sort().map(r => '<option value="' + E(r) + '"' + (r === cur ? ' selected' : '') + '>' + E(r) + '</option>').join('');
  }

  // Apply filters
  const filtered = getFilteredCams();
  const statusEl = $("cam-filter-status");
  if (statusEl) {
    statusEl.textContent = filtered.length < rtCameras.length
      ? filtered.length + " / " + rtCameras.length + " shown" : "";
  }

  if (!rtCameras.length) {
    grid.innerHTML =
      '<div class="cam-empty"><div class="cam-empty-icon">&#x1f4f7;</div>' +
      "<p>No camera feeds added.</p>" +
      '<p class="cam-empty-hint">Add public DOT traffic cams, weather station feeds, or any MJPEG/image stream URL.</p>' +
      '<button class="pri" onclick="openAddCam()" style="margin-top:10px">+ Add Camera Feed</button></div>';
    return;
  }

  if (!filtered.length) {
    grid.innerHTML = '<div class="cam-empty"><p>No cameras match current filters.</p></div>';
    return;
  }

  grid.innerHTML = filtered
    .map((cam) => {
      const proxyUrl = "/api/rt/cam/proxy?url=" + encodeURIComponent(cam.url) + "&_t=" + Date.now();
      let viewHtml;
      if (cam.type === "iframe") {
        viewHtml = '<iframe src="' + E(cam.url) + '" sandbox="allow-scripts allow-same-origin" loading="lazy" allow="autoplay; encrypted-media"></iframe>';
      } else {
        viewHtml = '<a href="' + E(cam.url) + '" target="_blank" rel="noopener" title="Open camera source" style="display:block;width:100%;height:100%">' +
          '<img src="' + E(proxyUrl) + '" alt="' + E(cam.name) + '" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.parentElement.outerHTML=\'<div class=cam-err onclick=refreshAllCams() style=cursor:pointer title=Click_to_retry>Feed unavailable — tap to retry</div>\'">' +
          '</a>';
      }

      const catLabel = CAM_CAT_LABELS[cam.cat] || cam.cat;
      const liveLabel = cam.type === "mjpeg" ? '<div class="cam-live-bar">LIVE</div>'
        : cam.type === "iframe" ? '<div class="cam-live-bar" style="background:rgba(59,130,246,.85)">STREAM</div>' : "";
      const statusBadge = cam.status === "unverified"
        ? '<span class="cam-tag" style="background:var(--st-yl-bg);color:var(--yl);border:1px solid var(--yl)">?</span>' : "";
      const regionBadge = cam.region
        ? '<span class="cam-tag" style="opacity:.7">' + E(cam.region) + '</span>' : "";

      return (
        '<div class="cam-card" data-cam-id="' + cam.id + '">' +
        '<div class="cam-view">' + liveLabel + viewHtml + "</div>" +
        '<div class="cam-info">' +
        '<span class="cam-name">' + E(cam.name) + "</span>" +
        statusBadge +
        '<span class="cam-tag">' + E(catLabel) + "</span>" +
        regionBadge +
        '<div class="cam-actions">' +
        '<button onclick="removeCam(\'' + cam.id + "')\">&#x2715;</button>" +
        "</div></div></div>"
      );
    })
    .join("");

  // Update live dot
  const hasActive = rtCameras.length > 0 || rtServices.length > 0;
  $("rt-live-dot").className = "tab-live-dot" + (hasActive ? " active" : "");

  // Refresh global region filter
  populateGlobalRegionFilter();
}

/** Get cameras filtered by current filter bar settings */
function getFilteredCams() {
  const srcFilter = ($("cam-filter-source") || {}).value || "";
  const regFilter = ($("cam-filter-region") || {}).value || "";
  const catFilter = ($("cam-filter-cat") || {}).value || "";
  const searchFilter = (($("cam-filter-search") || {}).value || "").toLowerCase().trim();
  const globalRegion = ($("rt-region-filter") || {}).value || "";

  return rtCameras.filter(c => {
    if (srcFilter && (c.source || "") !== srcFilter) return false;
    if (regFilter && (c.region || "") !== regFilter) return false;
    if (catFilter && (c.cat || "") !== catFilter) return false;
    if (searchFilter && !(c.name || "").toLowerCase().includes(searchFilter)) return false;
    if (globalRegion && (c.region || "") !== globalRegion) return false;
    return true;
  });
}

function applyCamFilters() { renderCams(); }

/** Populate and apply the global region filter (cameras + flights) */
function applyGlobalRegionFilter() {
  renderCams();
  renderFlights();
  updateGlobalRegionStatus();
}

function updateGlobalRegionStatus() {
  const region = ($("rt-region-filter") || {}).value || "";
  const statusEl = $("rt-region-status");
  if (!statusEl) return;
  if (!region) { statusEl.textContent = ""; return; }
  const camCount = getFilteredCams().length;
  const flightCount = getFilteredFlights().length;
  statusEl.textContent = camCount + " cam" + (camCount !== 1 ? "s" : "") + ", " + flightCount + " flight" + (flightCount !== 1 ? "s" : "");
}

/** Populate the global region dropdown from all sources (cameras + flights) */
function populateGlobalRegionFilter() {
  const regSet = new Set();
  rtCameras.forEach(c => { if (c.region) regSet.add(c.region); });
  rtFlights.forEach(f => { if (f.origin) regSet.add(f.origin); });

  const sel = $("rt-region-filter");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Regions</option>' +
    [...regSet].sort().map(r => '<option value="' + E(r) + '"' + (r === cur ? ' selected' : '') + '>' + E(r) + '</option>').join('');
}

/** Get flights filtered by global region */
function getFilteredFlights() {
  const globalRegion = ($("rt-region-filter") || {}).value || "";
  if (!globalRegion) return rtFlights;
  return rtFlights.filter(f => {
    // Match by origin country or by region tag
    return (f.origin || "") === globalRegion || (f.region || "") === globalRegion;
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
//  RT MONITOR — FLIGHT TRACKER
// ═══════════════════════════════════════════════════════════════════════════════

function openAddFlight() { $("flight-modal").classList.add("open"); }

function addFlight() {
  const callsign = $("flight-id").value.trim().toUpperCase();
  const source = $("flight-src").value;
  const notes = $("flight-notes").value.trim();

  if (!callsign) { toast("Callsign required"); return; }

  const flight = {
    id: uid(),
    callsign,
    source,
    notes,
    status: "unknown",
    lastCheck: null,
    data: null,
  };
  rtFlights.push(flight);

  closeModal("flight-modal");
  $("flight-id").value = "";
  $("flight-notes").value = "";

  renderFlights();
  rtLog("Flight tracking: " + callsign, "ok");
  checkFlight(flight);
  saveFlightsToServer();
}

function removeFlight(id) {
  const f = rtFlights.find((f) => f.id === id);
  rtFlights = rtFlights.filter((f) => f.id !== id);
  renderFlights();
  if (f) rtLog("Stopped tracking: " + f.callsign, "warn");
  saveFlightsToServer();
  refreshDiscoveryDupeState();
}

function removeAllFlights() {
  if (!rtFlights.length) { toast("No flights to remove"); return; }
  if (!confirm("Remove all " + rtFlights.length + " tracked flights?")) return;
  const count = rtFlights.length;
  rtFlights = [];
  renderFlights();
  saveFlightsToServer();
  refreshDiscoveryDupeState();
  rtLog("Removed all " + count + " flights", "warn");
  toast("Removed " + count + " flights");
}

async function checkFlight(flight) {
  flight.status = "checking";
  renderFlights();

  try {
    const data = await (
      await fetch("/api/rt/flight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callsign: flight.callsign, source: flight.source }),
      })
    ).json();

    flight.lastCheck = ts();
    if (data.error) {
      flight.status = "error";
      flight.data = data.error;
      rtLog("Flight " + flight.callsign + ": " + data.error, "warn");
    } else {
      flight.status = data.status || "tracked";
      // Store rich data from OpenSky/ADS-B
      flight.data = data.info || null;
      flight.position = data.position || null;
      flight.latitude = data.latitude || null;
      flight.longitude = data.longitude || null;
      flight.altitude = data.altitude || null;
      flight.baro_altitude = data.baro_altitude || null;
      flight.geo_altitude = data.geo_altitude || null;
      flight.velocity = data.velocity || null;
      flight.heading = data.heading || null;
      flight.vertical_rate = data.vertical_rate || null;
      flight.origin = data.origin_country || null;
      flight.on_ground = data.on_ground || false;
      flight.icao = data.icao || flight.icao || null;
      flight.squawk = data.squawk || null;
      flight.spi = data.spi || false;
      flight.position_source = data.position_source || null;
      flight.category = data.category || null;
      flight.category_id = data.category_id || null;
      flight.time_position = data.time_position || null;
      flight.last_contact = data.last_contact || null;
      flight.departure = data.departure || flight.departure || null;
      flight.destination = data.destination || flight.destination || null;
      flight.operator = data.operator || flight.operator || null;
      flight.flight_number = data.flight_number || flight.flight_number || null;
      flight.airline = data.airline || flight.airline || null;
      const detail = data.info || data.status || "checked";
      rtLog("Flight " + flight.callsign + ": " + detail, data.status === "error" ? "err" : "ok");
    }
  } catch (err) {
    flight.lastCheck = ts();
    flight.status = "error";
    flight.data = err.message;
    rtLog("Flight " + flight.callsign + " error: " + err.message, "err");
  }

  renderFlights();
}

function checkAllFlights() {
  rtFlights.forEach((f) => checkFlight(f));
  toast("Checking all flights...");
}

/** Open a detail modal for a flight */
function openFlightDetail(flightId) {
  const f = rtFlights.find(x => x.id === flightId);
  if (!f) return;

  $("fdm-title").textContent = f.callsign + (f.airline ? " — " + f.airline : "");

  // Build detail grid
  let html = '<div class="fdm-grid">';

  // Identity section
  html += '<div class="fdm-label">Callsign</div><div class="fdm-val large">' + E(f.callsign) + '</div>';
  if (f.airline) html += '<div class="fdm-label">Airline</div><div class="fdm-val">' + E(f.airline) + '</div>';
  if (f.icao) html += '<div class="fdm-label">ICAO 24-bit</div><div class="fdm-val" style="font-family:monospace">' + E(f.icao) + '</div>';
  html += '<div class="fdm-label">Status</div><div class="fdm-val">' + E(f.status || "unknown") + '</div>';
  html += '<div class="fdm-label">Source</div><div class="fdm-val">' + E(f.source || "—") + '</div>';
  if (f.origin) html += '<div class="fdm-label">Country</div><div class="fdm-val">' + E(f.origin) + '</div>';

  // Aircraft classification
  if (f.category) {
    html += '<div class="fdm-label">Aircraft Type</div><div class="fdm-val">' + E(f.category) + '</div>';
  }
  if (f.squawk) {
    let sqkNote = "";
    if (f.squawk === "7500") sqkNote = ' <span style="color:var(--rd);font-weight:700">HIJACK</span>';
    else if (f.squawk === "7600") sqkNote = ' <span style="color:var(--yl);font-weight:700">RADIO FAILURE</span>';
    else if (f.squawk === "7700") sqkNote = ' <span style="color:var(--rd);font-weight:700">EMERGENCY</span>';
    html += '<div class="fdm-label">Squawk</div><div class="fdm-val" style="font-family:monospace;font-size:15px;font-weight:600">' + E(f.squawk) + sqkNote + '</div>';
  }
  if (f.spi) {
    html += '<div class="fdm-label">SPI</div><div class="fdm-val" style="color:var(--yl)">IDENT ACTIVE</div>';
  }
  if (f.position_source) {
    html += '<div class="fdm-label">Position Src</div><div class="fdm-val">' + E(f.position_source) + '</div>';
  }

  html += '<div class="fdm-divider"></div>';

  // Route
  html += '<div class="fdm-label">Departure</div><div class="fdm-val">' + E(f.departure || "—") + '</div>';
  html += '<div class="fdm-label">Destination</div><div class="fdm-val">' + E(f.destination || "—") + '</div>';

  html += '<div class="fdm-divider"></div>';

  // Position & dynamics
  if (f.position && f.position !== "unknown") {
    html += '<div class="fdm-label">Position</div><div class="fdm-val">' + E(f.position);
    if (f.latitude != null && f.longitude != null) {
      html += ' <a href="https://www.google.com/maps?q=' + f.latitude + ',' + f.longitude + '" target="_blank" rel="noopener" style="font-size:10px;margin-left:6px">Map ↗</a>';
    }
    html += '</div>';
  }
  if (f.altitude != null) {
    const altFt = Math.round(f.altitude * 3.28084);
    html += '<div class="fdm-label">Altitude</div><div class="fdm-val">' + Math.round(f.altitude).toLocaleString() + ' m (' + altFt.toLocaleString() + ' ft)';
    if (f.baro_altitude != null && f.geo_altitude != null && f.baro_altitude !== f.geo_altitude) {
      html += '<br><span style="font-size:10px;color:var(--tx2)">Baro: ' + Math.round(f.baro_altitude).toLocaleString() + 'm | Geo: ' + Math.round(f.geo_altitude).toLocaleString() + 'm</span>';
    }
    html += '</div>';
  }
  if (f.velocity != null) {
    const kts = Math.round(f.velocity * 1.94384);
    const kmh = Math.round(f.velocity * 3.6);
    html += '<div class="fdm-label">Ground Speed</div><div class="fdm-val">' + Math.round(f.velocity) + ' m/s (' + kts + ' kts / ' + kmh + ' km/h)</div>';
  }
  if (f.heading != null) {
    const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    const dir = dirs[Math.round(f.heading / 22.5) % 16];
    html += '<div class="fdm-label">Heading</div><div class="fdm-val">' + Math.round(f.heading) + '\u00b0 ' + dir + '</div>';
  }
  if (f.vertical_rate != null && f.vertical_rate !== 0) {
    const fpm = Math.round(f.vertical_rate * 196.85);
    const arrow = f.vertical_rate > 0 ? "\u2197\ufe0f" : "\u2198\ufe0f";
    html += '<div class="fdm-label">Vertical Rate</div><div class="fdm-val">' + arrow + ' ' + f.vertical_rate.toFixed(1) + ' m/s (' + fpm.toLocaleString() + ' fpm)</div>';
  }
  if (f.on_ground) {
    html += '<div class="fdm-label">Ground</div><div class="fdm-val" style="color:var(--yl);font-weight:600">ON GROUND</div>';
  }

  html += '<div class="fdm-divider"></div>';

  // Timestamps
  if (f.time_position) {
    const d = new Date(f.time_position * 1000);
    html += '<div class="fdm-label">Pos Update</div><div class="fdm-val">' + d.toLocaleTimeString() + '</div>';
  }
  if (f.last_contact) {
    const d = new Date(f.last_contact * 1000);
    html += '<div class="fdm-label">Last Contact</div><div class="fdm-val">' + d.toLocaleTimeString() + '</div>';
  }
  html += '<div class="fdm-label">Last Check</div><div class="fdm-val">' + E(f.lastCheck || "—") + '</div>';
  if (f.notes) html += '<div class="fdm-label">Notes</div><div class="fdm-val">' + E(f.notes) + '</div>';

  html += '</div>';
  $("fdm-body").innerHTML = html;

  // External links
  const cs = (f.callsign || "").replace(/\s/g, "");
  $("fdm-track-link").href = "https://www.flightaware.com/live/flight/" + encodeURIComponent(cs);
  $("fdm-opensky-link").href = f.icao
    ? "https://opensky-network.org/aircraft-profile?icao24=" + encodeURIComponent(f.icao)
    : "https://opensky-network.org/network/explorer?callsign=" + encodeURIComponent(cs);

  // Refresh button
  $("fdm-refresh").onclick = function() {
    closeModal("flight-detail-modal");
    checkFlight(f);
    setTimeout(function() { openFlightDetail(f.id); }, 3000);
  };

  $("flight-detail-modal").classList.add("open");
}

function renderFlights() {
  $("flight-count").textContent = rtFlights.length;
  const table = $("flight-table");
  const empty = $("flight-empty");
  const tbody = $("flight-tbody");

  if (!rtFlights.length) {
    table.style.display = "none";
    empty.style.display = "block";
    return;
  }

  table.style.display = "table";
  empty.style.display = "none";

  // Apply global region filter
  const filtered = getFilteredFlights();
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--tx2);padding:16px">No flights match current region filter.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .map((f) => {
      const stClass =
        f.status === "tracked" || f.status === "active"
          ? "st-up"
          : f.status === "error"
          ? "st-down"
          : f.status === "checking"
          ? "st-pend"
          : "st-unk";

      const dep = f.departure || "\u2014";
      const dest = f.destination || "\u2014";

      // Build a detail string from rich data
      let detail = "";
      if (f.position && f.position !== "unknown") detail = "Pos: " + f.position;
      if (f.altitude != null) {
        const altFt = Math.round(f.altitude * 3.28084);
        detail += (detail ? " | " : "") + "Alt: " + altFt.toLocaleString() + "ft";
      }
      if (f.velocity != null) {
        const kts = Math.round(f.velocity * 1.94384);
        detail += (detail ? " | " : "") + "Spd: " + kts + "kts";
      }
      if (f.vertical_rate != null && Math.abs(f.vertical_rate) > 0.5) {
        const fpm = Math.round(f.vertical_rate * 196.85);
        detail += (detail ? " | " : "") + (fpm > 0 ? "\u2197" : "\u2198") + Math.abs(fpm) + "fpm";
      }
      if (f.origin) detail += (detail ? " | " : "") + f.origin;
      if (f.on_ground) detail += (detail ? " | " : "") + "ON GROUND";
      if (!detail && f.notes) detail = f.notes;
      if (!detail && f.data) detail = typeof f.data === "string" ? f.data : JSON.stringify(f.data);
      if (!detail) detail = "\u2014";

      // Squawk alert badges
      let sqkBadge = "";
      if (f.squawk === "7700") sqkBadge = '<span style="background:#e74c3c;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px;margin-left:4px;font-weight:700">EMERGENCY</span>';
      else if (f.squawk === "7600") sqkBadge = '<span style="background:#f39c12;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px;margin-left:4px;font-weight:700">RADIO</span>';
      else if (f.squawk === "7500") sqkBadge = '<span style="background:#e74c3c;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px;margin-left:4px;font-weight:700">HIJACK</span>';

      return (
        '<tr onclick="openFlightDetail(\'' + f.id + '\')" title="Click for details">' +
        "<td><b>" + E(f.callsign) + "</b>" + sqkBadge + (f.airline ? " <span style='opacity:.5;font-size:10px'>" + E(f.airline) + "</span>" : (f.operator ? " <span style='opacity:.5;font-size:10px'>" + E(f.operator) + "</span>" : "")) + "</td>" +
        "<td>" + E(f.source) + (f.category ? "<br><span style='font-size:9px;opacity:.5'>" + E(f.category) + "</span>" : "") + "</td>" +
        '<td class="' + stClass + '">' + E(f.status) + "</td>" +
        "<td>" + E(dep) + "</td>" +
        "<td>" + E(dest) + "</td>" +
        "<td style='font-size:11px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" + E(detail) + "</td>" +
        "<td>" + E(f.lastCheck || "\u2014") + "</td>" +
        '<td onclick="event.stopPropagation()">' +
        '<button onclick="checkFlight(rtFlights.find(x=>x.id===\'' + f.id + '\'))" title="Refresh">&#x27f3;</button> ' +
        '<button onclick="removeFlight(\'' + f.id + '\')" title="Remove">&#x2715;</button>' +
        "</td></tr>"
      );
    })
    .join("");

  populateGlobalRegionFilter();
  updateGlobalRegionStatus();
}


// ═══════════════════════════════════════════════════════════════════════════════
//  RT MONITOR — SERVICE MONITOR
// ═══════════════════════════════════════════════════════════════════════════════

function openAddSvc() { $("svc-modal").classList.add("open"); }

function addSvc() {
  const name = $("svc-name").value.trim();
  const url = $("svc-url").value.trim();
  const method = $("svc-method").value;
  const interval = parseInt($("svc-interval").value) || 60;

  if (!name || !url) { toast("Name and URL required"); return; }

  const svc = {
    id: uid(),
    name,
    url,
    method,
    interval,
    status: "unknown",
    latency: null,
    lastCheck: null,
  };
  rtServices.push(svc);

  closeModal("svc-modal");
  $("svc-name").value = "";
  $("svc-url").value = "";
  $("svc-interval").value = "60";

  renderSvcs();
  checkSvc(svc);
  startSvcTimer(svc);
  rtLog("Service monitor added: " + name, "ok");
  saveSvcsToServer();
}

function removeSvc(id) {
  if (rtSvcTimers[id]) { clearInterval(rtSvcTimers[id]); delete rtSvcTimers[id]; }
  const s = rtServices.find((s) => s.id === id);
  rtServices = rtServices.filter((s) => s.id !== id);
  renderSvcs();
  if (s) rtLog("Service removed: " + s.name, "warn");
  saveSvcsToServer();
}

function startSvcTimer(svc) {
  rtSvcTimers[svc.id] = setInterval(() => checkSvc(svc), svc.interval * 1000);
}

async function checkSvc(svc) {
  svc.status = "checking";
  renderSvcs();

  try {
    const data = await (
      await fetch("/api/rt/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: svc.url, method: svc.method }),
      })
    ).json();

    svc.lastCheck = ts();
    svc.status = data.up ? "up" : "down";
    svc.latency = data.latency_ms || null;
    svc.httpCode = data.http_code || null;
    svc.contentType = data.content_type || null;
    svc.detail = data.detail || null;
    svc.tlsInfo = data.tls || null;
    svc.redirects = data.redirects || null;
    svc.serverHeader = data.server || null;

    if (!data.up) {
      rtLog("Service DOWN: " + svc.name + " — " + (data.detail || "unreachable"), "err");
    }
  } catch (err) {
    svc.lastCheck = ts();
    svc.status = "error";
    svc.latency = null;
    svc.detail = err.message;
    rtLog("Service error: " + svc.name + " — " + err.message, "err");
  }

  renderSvcs();
}

function checkAllSvcs() {
  rtServices.forEach((s) => checkSvc(s));
  toast("Checking all services...");
}

function renderSvcs() {
  $("svc-count").textContent = rtServices.length;
  const table = $("svc-table");
  const empty = $("svc-empty");
  const tbody = $("svc-tbody");

  if (!rtServices.length) {
    table.style.display = "none";
    empty.style.display = "block";
    return;
  }

  table.style.display = "table";
  empty.style.display = "none";

  tbody.innerHTML = rtServices
    .map((s) => {
      const stClass =
        s.status === "up"
          ? "st-up"
          : s.status === "down" || s.status === "error"
          ? "st-down"
          : s.status === "checking"
          ? "st-pend"
          : "st-unk";
      const stLabel =
        s.status === "up"
          ? "\u2713 UP"
          : s.status === "down"
          ? "\u2717 DOWN"
          : s.status === "checking"
          ? "..."
          : s.status;

      // Build a detail tooltip from curl data
      let detailParts = [];
      if (s.httpCode) detailParts.push("HTTP " + s.httpCode);
      if (s.contentType) detailParts.push(s.contentType);
      if (s.serverHeader) detailParts.push(s.serverHeader);
      if (s.tlsInfo) detailParts.push(s.tlsInfo);
      if (s.redirects) detailParts.push(s.redirects + " redirect(s)");
      const detailTip = detailParts.join(" \u00b7 ") || (s.detail || "");

      return (
        "<tr>" +
        "<td><b>" + E(s.name) + "</b></td>" +
        '<td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + E(s.url) + "</td>" +
        "<td>" + E(s.method.toUpperCase()) + "</td>" +
        '<td class="' + stClass + '" title="' + A(detailTip) + '">' + stLabel + "</td>" +
        "<td>" + (s.latency != null ? s.latency + "ms" : "\u2014") + "</td>" +
        "<td>" + E(s.lastCheck || "\u2014") + "</td>" +
        "<td>" +
        '<button onclick="checkSvc(rtServices.find(x=>x.id===\'' + s.id + '\'))" title="Check now">&#x27f3;</button> ' +
        '<button onclick="removeSvc(\'' + s.id + '\')" title="Remove">&#x2715;</button>' +
        "</td></tr>"
      );
    })
    .join("");

  // Update live dot based on whether there are active monitors
  const hasActive = rtCameras.length > 0 || rtServices.length > 0;
  $("rt-live-dot").className = "tab-live-dot" + (hasActive ? " active" : "");
}


// ═══════════════════════════════════════════════════════════════════════════════
//  RT MONITOR — PERSISTENCE (server-side)
// ═══════════════════════════════════════════════════════════════════════════════

async function saveCamsToServer() {
  try {
    await fetch("/api/rt/cameras", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cameras: rtCameras }),
    });
  } catch (_) {}
}

async function saveFlightsToServer() {
  try {
    await fetch("/api/rt/flights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flights: rtFlights }),
    });
  } catch (_) {}
}

async function saveSvcsToServer() {
  try {
    await fetch("/api/rt/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ services: rtServices }),
    });
  } catch (_) {}
}

async function loadRtState() {
  try {
    const data = await (await fetch("/api/rt/state")).json();
    if (data.cameras?.length) {
      rtCameras = data.cameras;
      renderCams();
      rtCameras.forEach((c) => startCamRefresh(c));
    }
    if (data.flights?.length) {
      rtFlights = data.flights;
      renderFlights();
    }
    if (data.services?.length) {
      rtServices = data.services;
      renderSvcs();
      rtServices.forEach((s) => startSvcTimer(s));
    }
  } catch (_) {}

  // Seed default services if none are configured
  if (!rtServices.length) {
    seedDefaultServices();
  }
}

/** Seed the service monitor with essential internet infrastructure services */
function seedDefaultServices() {
  const defaults = [
    { name: "Google",          url: "https://www.google.com",      method: "http", interval: 60 },
    { name: "Cloudflare DNS",  url: "https://1.1.1.1",             method: "http", interval: 60 },
    { name: "Cloudflare",      url: "https://www.cloudflare.com",  method: "http", interval: 120 },
    { name: "AWS",             url: "https://aws.amazon.com",      method: "http", interval: 120 },
    { name: "GitHub",          url: "https://github.com",          method: "http", interval: 120 },
    { name: "OpenAI",          url: "https://api.openai.com",      method: "http", interval: 120 },
    { name: "YouTube",         url: "https://www.youtube.com",     method: "http", interval: 120 },
    { name: "Reddit",          url: "https://www.reddit.com",      method: "http", interval: 120 },
    { name: "Anthropic",       url: "https://www.anthropic.com",   method: "http", interval: 120 },
    { name: "Google DNS",      url: "https://dns.google",           method: "http", interval: 60 },
    { name: "Quad9 DNS",       url: "https://dns.quad9.net",        method: "http", interval: 60 },
  ];

  defaults.forEach(d => {
    const svc = {
      id: uid(), name: d.name, url: d.url, method: d.method,
      interval: d.interval, status: "unknown", latency: null, lastCheck: null,
    };
    rtServices.push(svc);
    startSvcTimer(svc);
  });

  renderSvcs();
  saveSvcsToServer();
  rtLog("Seeded " + defaults.length + " default service monitors", "ok");
  setTimeout(() => checkAllSvcs(), 500);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  MODALS (shared helper)
// ═══════════════════════════════════════════════════════════════════════════════

function closeModal(id, event) {
  if (!event || event.target.id === id) {
    $(id).classList.remove("open");
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

(async function init() {
  fetchUsage();

  try {
    const data = await (await fetch("/api/models")).json();
    modelsCache = data.models || [];
    if (data.llama) updateLlamaUI(data.llama);
  } catch (_) {}

  // Load RT state from server
  loadRtState();

  // Auto-scan news feeds on startup
  scan();
})();