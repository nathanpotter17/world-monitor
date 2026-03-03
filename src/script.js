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
    refresh: cam.type === "mjpeg" ? 5 : 15,
    cat: cam.cat || "traffic",
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
      refresh: cam.type === "mjpeg" ? 5 : 15,
      cat: cam.cat || "traffic",
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
      refresh: cam.type === "mjpeg" ? 5 : 15,
      cat: cam.cat || "traffic",
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
      refresh: cam.type === "mjpeg" ? 5 : 15,
      cat: cam.cat || "traffic",
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

  // Validate camera URL via server-side curl
  let validated = false;
  try {
    const check = await (
      await fetch("/api/rt/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, method: "http" }),
      })
    ).json();

    if (check.up) {
      validated = true;
      rtLog("Camera validated: " + name + " (HTTP " + (check.http_code || "ok") + ")", "ok");
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
  // ALL camera types auto-refresh via server proxy (snapshot mode)
  // This handles MJPEG (extracts single frame), still images, and CORS
  const interval = cam.type === "mjpeg" ? Math.max(cam.refresh, 3) : cam.refresh;
  if (cam.type !== "iframe") {
    rtCamTimers[cam.id] = setInterval(() => {
      const img = document.querySelector(`[data-cam-id="${cam.id}"] img`);
      if (img) {
        img.src = "/api/rt/cam/proxy?url=" + encodeURIComponent(cam.url) + "&_t=" + Date.now();
      }
    }, interval * 1000);
  }
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

  if (!rtCameras.length) {
    grid.innerHTML =
      '<div class="cam-empty">' +
      '<div class="cam-empty-icon">&#x1f4f7;</div>' +
      "<p>No camera feeds added.</p>" +
      '<p class="cam-empty-hint">Add public DOT traffic cams, weather station feeds, or any MJPEG/image stream URL.</p>' +
      '<button class="pri" onclick="openAddCam()" style="margin-top:10px">+ Add Camera Feed</button>' +
      "</div>";
    return;
  }

  grid.innerHTML = rtCameras
    .map((cam) => {
      const proxyUrl = "/api/rt/cam/proxy?url=" + encodeURIComponent(cam.url) + "&_t=" + Date.now();
      let viewHtml;
      if (cam.type === "iframe") {
        viewHtml = '<iframe src="' + E(cam.url) + '" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe>';
      } else {
        // ALL image types (still + MJPEG) go through proxy snapshot
        viewHtml = '<img src="' + E(proxyUrl) + '" alt="' + E(cam.name) + '" onerror="this.outerHTML=\'<div class=cam-err>Feed unavailable</div>\'">';
      }

      const catLabel = CAM_CAT_LABELS[cam.cat] || cam.cat;
      const liveLabel = cam.type === "mjpeg" ? '<div class="cam-live-bar">LIVE</div>' : "";
      const statusBadge = cam.status === "unverified"
        ? '<span class="cam-tag" style="background:var(--st-yl-bg);color:var(--yl);border:1px solid var(--yl)">?</span>'
        : "";

      return (
        '<div class="cam-card" data-cam-id="' + cam.id + '">' +
        '<div class="cam-view">' + liveLabel + viewHtml + "</div>" +
        '<div class="cam-info">' +
        '<span class="cam-name">' + E(cam.name) + "</span>" +
        statusBadge +
        '<span class="cam-tag">' + E(catLabel) + "</span>" +
        '<div class="cam-actions">' +
        '<button onclick="removeCam(\'' + cam.id + "')\">&#x2715;</button>" +
        "</div></div></div>"
      );
    })
    .join("");

  // Update live dot
  $("rt-live-dot").className = "tab-live-dot" + (rtCameras.length > 0 ? " active" : "");
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
      flight.altitude = data.altitude || null;
      flight.velocity = data.velocity || null;
      flight.heading = data.heading || null;
      flight.origin = data.origin_country || null;
      flight.on_ground = data.on_ground || false;
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

  tbody.innerHTML = rtFlights
    .map((f) => {
      const stClass =
        f.status === "tracked" || f.status === "active"
          ? "st-up"
          : f.status === "error"
          ? "st-down"
          : f.status === "checking"
          ? "st-pend"
          : "st-unk";

      // Build a detail string from rich data if available
      let detail = f.notes || "";
      if (f.position) {
        detail = "Pos: " + f.position;
      }
      if (f.altitude != null) {
        detail += (detail ? " | " : "") + "Alt: " + f.altitude + "m";
      }
      if (f.velocity != null) {
        detail += (detail ? " | " : "") + "Spd: " + Math.round(f.velocity) + "m/s";
      }
      if (f.heading != null) {
        detail += (detail ? " | " : "") + "Hdg: " + Math.round(f.heading) + "\u00b0";
      }
      if (f.origin) {
        detail += (detail ? " | " : "") + f.origin;
      }
      if (f.on_ground) {
        detail += (detail ? " | " : "") + "ON GROUND";
      }
      if (!detail && f.data) {
        detail = typeof f.data === "string" ? f.data : JSON.stringify(f.data);
      }
      if (!detail) detail = "\u2014";

      return (
        "<tr>" +
        "<td><b>" + E(f.callsign) + "</b></td>" +
        "<td>" + E(f.source) + "</td>" +
        '<td class="' + stClass + '">' + E(f.status) + "</td>" +
        "<td style='font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" + E(detail) + "</td>" +
        "<td>" + E(f.lastCheck || "\u2014") + "</td>" +
        "<td>" +
        '<button onclick="checkFlight(rtFlights.find(x=>x.id===\'' + f.id + '\'))" title="Refresh">&#x27f3;</button> ' +
        '<button onclick="removeFlight(\'' + f.id + '\')" title="Remove">&#x2715;</button>' +
        "</td></tr>"
      );
    })
    .join("");
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