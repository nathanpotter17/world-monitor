/**
 * @file script.js
 * @description World Monitor — client-side dashboard controller.
 *
 * Handles NewsMonitor (RSS + AI), model management, budget tracking,
 * and drill-down analysis.
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



// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let settingsPanelOpen = false;
let modelsCache = [];



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
    '<div class="it" data-headline="' + A(item.headline) + '" data-link="' + A(item.link || "") + '">' +
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

// Delegate click on headline items — avoids inline onclick escaping issues
document.addEventListener("click", function(e) {
  const it = e.target.closest(".it[data-headline]");
  if (it) {
    drill(it.dataset.headline, it.dataset.link);
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// AI ASK (NewsMonitor) — with follow-up suggestions
// ═══════════════════════════════════════════════════════════════════════════════

let _askHistory = []; // conversation thread for the ask panel

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

  // If we already have history, append as a thread; otherwise start fresh
  if (_askHistory.length === 0) {
    textEl.innerHTML = "";
  }

  // Append the user's question
  const qDiv = document.createElement("div");
  qDiv.className = "ask-user-msg";
  qDiv.textContent = query;
  textEl.appendChild(qDiv);

  // Append loading
  const loadDiv = document.createElement("div");
  loadDiv.className = "ask-ai-msg";
  loadDiv.innerHTML = LOADING_HTML;
  textEl.appendChild(loadDiv);
  metaEl.textContent = "";

  // Scroll to bottom
  textEl.scrollTop = textEl.scrollHeight;

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

    const answer = data.answer || data.error || "No response";
    _askHistory.push({ q: query, a: answer });

    loadDiv.textContent = answer;

    // Add follow-up suggestion chips
    const followUps = generateFollowUps(query, answer, category);
    if (followUps.length) {
      const chipDiv = document.createElement("div");
      chipDiv.className = "ask-followup-chips";
      followUps.forEach(function(f) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = f;
        chip.onclick = function() { $("qi").value = f; ask(category); };
        chipDiv.appendChild(chip);
      });
      textEl.appendChild(chipDiv);
    }

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
    loadDiv.textContent = "Error: " + err.message;
    loadDiv.style.color = "var(--rd)";
  }

  // Scroll to bottom and clear input
  textEl.scrollTop = textEl.scrollHeight;
  $("qi").value = "";
  $("qi").focus();
}

function generateFollowUps(query, answer, category) {
  // Generate contextual follow-up suggestions
  const suggestions = [];
  const q = query.toLowerCase();
  if (q.includes("summar")) {
    suggestions.push("What are the implications?");
    suggestions.push("Which story is most significant?");
  } else if (q.includes("market") || q.includes("econ")) {
    suggestions.push("What sectors are most affected?");
    suggestions.push("Any contrarian signals?");
  } else if (q.includes("tech") || q.includes("ai")) {
    suggestions.push("What are the risks?");
    suggestions.push("Who benefits most?");
  } else if (q.includes("geopolit") || q.includes("secur")) {
    suggestions.push("What should we watch next?");
    suggestions.push("Historical parallels?");
  } else {
    suggestions.push("Tell me more");
    suggestions.push("What are the implications?");
  }
  if (answer.length > 200) {
    suggestions.push("Summarize in one sentence");
  }
  return suggestions.slice(0, 3);
}

function closeAI() {
  $("aip").classList.remove("open");
  _askHistory = [];
  $("ait").innerHTML = "";
}


// ═══════════════════════════════════════════════════════════════════════════════
// DRILL-DOWN (NewsMonitor) — threaded conversation with auto-AI
// ═══════════════════════════════════════════════════════════════════════════════

/** Thread state: array of {topic, link, text, ai, tokens, elapsed_ms, type} */
let _drillThread = [];
let _drillText = "";    // scraped article text from original drill
let _drillLink = "";
let _drillBusy = false; // prevent overlapping AI calls

async function drill(topic, link) {
  const overlay = $("ov");
  const content = $("drc");

  // Reset thread for a fresh drill
  _drillThread = [];
  _drillText = "";
  _drillLink = link || "";
  _drillBusy = false;

  overlay.classList.add("open");
  content.innerHTML = '<div class="drill-header"><h2>' + E(topic) + '</h2>' +
    (link ? '<a class="dl" href="' + E(link) + '" target="_blank">\u2192 Source</a>' : '') +
    '</div><div id="drill-thread">' + LOADING_HTML + '<p style="color:var(--tx2);font-size:12px">Fetching article\u2026</p></div>' +
    renderDrillInput();

  try {
    const data = await (
      await fetch("/api/drill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, link }),
      })
    ).json();

    if (data.error) {
      $("drill-thread").innerHTML = '<div class="drill-err">' + E(data.error) + '</div>';
      return;
    }

    _drillText = data.scraped_text || "";

    // Show scraped content as a collapsed detail if available
    let scrapeHtml = "";
    const info = data.drill || {};
    if (info.detail && data.mode === "page") {
      scrapeHtml = '<details class="drill-scraped"><summary class="drill-scraped-label label-caps">' +
        '\ud83d\udcc4 Scraped Content <span style="font-weight:normal;opacity:.6">(' +
        Math.round((info.detail || "").length / 100) / 10 + 'kB)</span></summary>' +
        '<div class="drill-scraped-text">' + E(info.detail) + '</div></details>';
    } else if (data.mode === "none") {
      scrapeHtml = '<div class="drill-note">Could not fetch article \u2014 AI will analyze the headline.</div>';
    }

    $("drill-thread").innerHTML = scrapeHtml;

    // Auto-trigger AI analysis
    drillAI(topic);
  } catch (err) {
    $("drill-thread").innerHTML = '<div class="drill-err">' + E(err.message) + '</div>';
  }
}

/** Core AI call — appends a thread entry (used for initial + follow-ups) */
async function drillAI(topic, question) {
  if (_drillBusy) { toast("AI is already processing\u2026"); return; }
  _drillBusy = true;

  const thread = $("drill-thread");
  if (!thread) { _drillBusy = false; return; }

  // Build context from prior thread entries
  const context = _drillThread
    .map(function(e) { return "## " + e.topic + "\n" + (e.summary || ""); })
    .join("\n\n");

  // Add loading entry
  const entryId = "drill-entry-" + Date.now();
  const loadEl = document.createElement("div");
  loadEl.id = entryId;
  loadEl.className = "drill-entry drill-entry-loading";
  loadEl.innerHTML = '<div class="drill-entry-head">' +
    '<span class="drill-entry-icon">\ud83e\udde0</span>' +
    '<span class="drill-entry-topic">' + E(question ? "Follow-up" : topic) + '</span>' +
    '<span class="drill-entry-status">\u23f3 Analyzing\u2026</span></div>' +
    LOADING_HTML;
  thread.appendChild(loadEl);
  scrollDrill(loadEl);

  // Disable input while processing
  const input = $("drill-followup");
  if (input) input.disabled = true;

  try {
    const payload = { topic, text: _drillText, context };
    if (question) payload.question = question;

    const data = await (
      await fetch("/api/drill/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    ).json();

    const el = $(entryId);
    if (!el) { _drillBusy = false; return; }

    if (data.error) {
      el.className = "drill-entry drill-entry-err";
      el.innerHTML = '<div class="drill-entry-head">' +
        '<span class="drill-entry-icon">\u26a0\ufe0f</span>' +
        '<span class="drill-entry-topic">' + E(topic) + '</span></div>' +
        '<div class="drill-entry-body">' + E(data.error) + '</div>';
      _drillBusy = false;
      if (input) input.disabled = false;
      return;
    }

    const ai = data.ai || {};

    // Store in thread
    _drillThread.push({
      topic: ai.title || topic,
      summary: ai.summary || "",
      key_points: ai.key_points || [],
      related: ai.related || [],
      tokens: data.tokens || 0,
      elapsed_ms: data.elapsed_ms || 0,
      question: question || null,
    });

    // Render the completed entry
    el.className = "drill-entry";
    let html = '<div class="drill-entry-head">' +
      '<span class="drill-entry-icon">\ud83e\udde0</span>' +
      '<span class="drill-entry-topic">' + E(ai.title || topic) + '</span>' +
      '<span class="drill-entry-meta">' +
      (data.tokens ? data.tokens.toLocaleString() + ' tok' : '') +
      (data.elapsed_ms ? ' \u00b7 ' + fmtMs(data.elapsed_ms) : '') +
      '</span></div>';

    if (question) {
      html += '<div class="drill-entry-question">\ud83d\udcac ' + E(question) + '</div>';
    }

    if (ai.summary) {
      html += '<div class="drill-entry-body">' + E(ai.summary) + '</div>';
    }

    if (ai.key_points && ai.key_points.length) {
      html += '<div class="drill-entry-points">';
      ai.key_points.forEach(function(p) {
        html += '<div class="drill-entry-point">\u2022 ' + E(p) + '</div>';
      });
      html += '</div>';
    }

    if (ai.related && ai.related.length) {
      html += '<div class="drill-entry-related">';
      ai.related.forEach(function(r) {
        html += '<span class="chip" onclick="drillFollowUp(\'' + A(r) + '\')">' + E(r) + '</span>';
      });
      html += '</div>';
    }

    el.innerHTML = html;
    scrollDrill(el);

    if (data.elapsed_ms) {
      toast((data.tokens ? data.tokens.toLocaleString() + " tok \u00b7 " : "") + fmtMs(data.elapsed_ms));
      showTime(data.elapsed_ms);
    }
    fetchUsage();
  } catch (err) {
    const el = $(entryId);
    if (el) {
      el.className = "drill-entry drill-entry-err";
      el.innerHTML = '<div class="drill-entry-body" style="color:var(--rd)">Error: ' + E(err.message) + '</div>';
    }
  }

  _drillBusy = false;
  if (input) { input.disabled = false; input.focus(); }
}

/** Follow-up: user clicked a related topic chip — drills deeper in-thread */
function drillFollowUp(topic) {
  drillAI(topic);
}

/** Follow-up: user typed a question in the input */
function drillAskFollowUp() {
  const input = $("drill-followup");
  if (!input) return;
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  const topic = _drillThread.length > 0 ? _drillThread[0].topic : "this article";
  drillAI(topic, q);
}

function renderDrillInput() {
  return '<div class="drill-input-bar" id="drill-input-bar">' +
    '<input class="drill-followup-input" id="drill-followup" ' +
    'placeholder="Ask a follow-up question\u2026" ' +
    'onkeydown="if(event.key===\'Enter\')drillAskFollowUp()">' +
    '<button class="pri drill-followup-btn" onclick="drillAskFollowUp()">\u2192</button>' +
    '</div>';
}

function scrollDrill(el) {
  // Scroll the drill panel to show the new entry
  const dp = el.closest(".dp");
  if (dp) {
    setTimeout(function() { dp.scrollTo({ top: dp.scrollHeight, behavior: "smooth" }); }, 60);
  }
}

function closeDrill(event) {
  if (!event || event.target.id === "ov") {
    $("ov").classList.remove("open");
    _drillBusy = false;
  }
}
const cdrill = closeDrill;


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

  // Auto-scan news feeds on startup
  scan();
})();