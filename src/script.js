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
            const ok = f.status.includes("items") && !f.status.includes(" 0 items");
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
  _expandedCategory = null;

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

/** Select items diversified by source (round-robin across unique sources) */
function diversifyBySource(items, maxItems) {
  const bySource = {};
  const sourceOrder = [];
  items.forEach(function(item) {
    if (!bySource[item.source]) {
      bySource[item.source] = [];
      sourceOrder.push(item.source);
    }
    bySource[item.source].push(item);
  });

  const result = [];
  let round = 0;
  while (result.length < maxItems) {
    let added = false;
    for (let si = 0; si < sourceOrder.length && result.length < maxItems; si++) {
      const src = sourceOrder[si];
      if (round < bySource[src].length) {
        result.push(bySource[src][round]);
        added = true;
      }
    }
    if (!added) break;
    round++;
  }
  return result;
}

/** Currently expanded category (null = default diversified view) */
let _expandedCategory = null;
let _allCategoriesData = [];
let _lastScanMeta = { okFeeds: 0, totalFeeds: 0, total: 0 };

function renderHeadlines(categories, total, okFeeds, totalFeeds) {
  _allCategoriesData = categories;
  if (total !== undefined) _lastScanMeta = { okFeeds, totalFeeds, total };
  const meta = _lastScanMeta;

  const metaHtml =
    '<div class="meta"><span>' +
    meta.okFeeds + "/" + meta.totalFeeds + " feeds &middot; " + meta.total + " headlines" +
    "</span><span>" + new Date().toLocaleTimeString() + "</span></div>";

  const catsHtml = categories
    .map(function(cat) {
      const perCat = cat.per_category || 5;
      const isExpanded = _expandedCategory === cat.category;
      const displayItems = isExpanded
        ? cat.items
        : diversifyBySource(cat.items, perCat);

      // Count unique sources
      const uniqueSources = [...new Set(cat.items.map(function(i) { return i.source; }))];
      const sourceCountLabel = uniqueSources.length + " source" + (uniqueSources.length !== 1 ? "s" : "");

      return (
        '<div class="cat' + (isExpanded ? ' cat-expanded' : '') + '">' +
        '<div class="ch" data-category="' + A(cat.category) + '">' +
        '<span class="ci">' + cat.icon + "</span>" +
        '<span class="ct label-caps">' + E(cat.category) + "</span>" +
        '<span class="csrc">' + sourceCountLabel + '</span>' +
        '<span class="cc">' + displayItems.length +
          (isExpanded ? '' : '/' + cat.items.length) + "</span>" +
        '<span class="cexp">' + (isExpanded ? '\u25b4' : '\u25be') + '</span>' +
        "</div>" +
        displayItems.map(function(i) { return renderItem(i, cat.category); }).join("") +
        (isExpanded && cat.items.length > 10
          ? '<div class="cat-fade"></div>'
          : '') +
        "</div>"
      );
    })
    .join("");

  return metaHtml + catsHtml;
}

// Click handler for category headers — toggles expanded view
document.addEventListener("click", function(e) {
  const ch = e.target.closest(".ch[data-category]");
  if (!ch) return;

  const cat = ch.dataset.category;
  if (_expandedCategory === cat) {
    _expandedCategory = null; // collapse
  } else {
    _expandedCategory = cat; // expand this one
  }

  // Re-render from cached data
  const container = $("hl");
  container.innerHTML = renderHeadlines(_allCategoriesData);

  // Scroll expanded category into view
  if (_expandedCategory) {
    const expanded = container.querySelector('.cat-expanded');
    if (expanded) expanded.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

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
let _askCategory = null; // last used category filter

function askQ(query, category) {
  // Call ask directly with query — don't put it in the search bar
  ask(category, query);
}

async function ask(category, directQuery) {
  // Use directQuery if provided (from chips/path cards), otherwise read from input
  const query = directQuery || $("qi").value.trim();
  if (!query) { toast("Type a question first"); return; }

  // Clear the search bar only if the user typed in it
  if (!directQuery) $("qi").value = "";

  _askCategory = category || null;

  const panel = $("aip");
  const textEl = $("ait");
  const metaEl = $("aim");

  panel.classList.add("open");

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

  // Remove old ask input bar and path cards (will re-add after response)
  var oldInput = textEl.querySelector(".ask-input-bar");
  if (oldInput) oldInput.remove();
  var oldPaths = textEl.querySelector(".ask-paths:last-of-type");

  textEl.scrollTop = textEl.scrollHeight;

  try {
    const payload = { query };
    if (category) payload.category = category;

    const resp = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await resp.text();

    // Try to parse JSON, handle control character issues
    var data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      // Attempt to clean control characters and retry
      var cleaned = raw.replace(/[\x00-\x1f\x7f]/g, function(c) {
        if (c === '\n' || c === '\r' || c === '\t') return ' ';
        return '';
      });
      try {
        data = JSON.parse(cleaned);
      } catch (_) {
        throw new Error("JSON parse error: " + parseErr.message);
      }
    }

    // Handle response: data.ai.answer + data.ai.follow_ups
    const ai = data.ai || {};
    const answer = ai.answer || data.answer || data.error || "No response";
    var followUps = ai.follow_ups || [];
    _askHistory.push({ q: query, a: answer, category: category });

    loadDiv.textContent = answer;

    // Only add fallback follow-ups if the AI call timed out (>180s)
    var elapsedMs = data.elapsed_ms || 0;
    if (followUps.length < 2 && elapsedMs > 180000) {
      var fallbacks = [
        { question: "What are the broader implications of this?", hint: "Impact analysis" },
        { question: "Which sources have the most contrasting perspectives?", hint: "Cross-reference feeds" },
        { question: "How does this connect to other categories?", hint: "Cross-feed analysis" },
      ];
      while (followUps.length < 2 && fallbacks.length > 0) {
        followUps.push(fallbacks.shift());
      }
    }

    // Render path cards — clicking opens drill overlay for deeper exploration
    if (followUps.length > 0) {
      var pathsDiv = document.createElement("div");
      pathsDiv.className = "ask-paths";

      var divider = document.createElement("div");
      divider.className = "ask-paths-divider";
      divider.innerHTML = '<div class="ask-paths-line"></div><span class="ask-paths-label label-caps">Dive deeper</span><div class="ask-paths-line"></div>';
      pathsDiv.appendChild(divider);

      followUps.forEach(function(f) {
        var q = typeof f === "string" ? f : (f.question || String(f));
        var hint = typeof f === "object" ? (f.hint || "") : "";
        var card = document.createElement("div");
        card.className = "ask-path-card";
        card.innerHTML =
          '<div class="ask-path-inner">' +
          '<div><div class="ask-path-q">' + E(q) + '</div>' +
          (hint ? '<div class="ask-path-hint">' + E(hint) + '</div>' : '') +
          '</div><span class="ask-path-arrow">&#x203A;</span></div>';
        // Click opens drill overlay for this question
        card.onclick = function() { openDrillFromAsk(q); };
        pathsDiv.appendChild(card);
      });

      textEl.appendChild(pathsDiv);
    }

    // Add follow-up input bar inside the AI panel
    var askBar = document.createElement("div");
    askBar.className = "ask-input-bar";
    askBar.innerHTML =
      '<input class="ask-followup-input" id="ask-followup" ' +
      'placeholder="Ask a follow-up question\u2026" ' +
      'onkeydown="if(event.key===\'Enter\')askFollowUp()">' +
      '<button class="pri ask-followup-btn" onclick="askFollowUp()">\u2192</button>';
    textEl.appendChild(askBar);

    var parts = [];
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

  textEl.scrollTop = textEl.scrollHeight;

  // Focus the in-panel input if it exists, otherwise the top bar
  var inPanelInput = $("ask-followup");
  if (inPanelInput) inPanelInput.focus();
  else $("qi").focus();
}

/** Follow-up typed in the AI panel's own input bar */
function askFollowUp() {
  var input = $("ask-followup");
  if (!input) return;
  var q = input.value.trim();
  if (!q) return;
  input.value = "";
  ask(_askCategory, q);
}

/** Open drill overlay from an ask panel path card */
function openDrillFromAsk(question) {
  // Close the ask panel, open drill with the question as topic
  // Pass empty link — drill will use AI + live search
  drill(question, "");
}

function closeAI() {
  $("aip").classList.remove("open");
  _askHistory = [];
  _askCategory = null;
  $("ait").innerHTML = "";
}


// ═══════════════════════════════════════════════════════════════════════════════
// DRILL-DOWN — Fortune Teller depth stack
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Thread state: array of depth entries.
 * Each: {topic, link, question, ai, tokens, elapsed_ms, news_sources, follow_ups}
 */
let _drillThread = [];
let _drillText = "";       // scraped article text from original drill
let _drillLink = "";
let _drillBusy = false;
let _drillTopic = "";      // original headline topic

async function drill(topic, link) {
  const overlay = $("ov");
  const content = $("drc");

  _drillThread = [];
  _drillText = "";
  _drillLink = link || "";
  _drillBusy = false;
  _drillTopic = topic;

  overlay.classList.add("open");
  content.innerHTML = '<div class="drill-header"><h2>' + E(topic) + '</h2>' +
    (link ? '<a class="dl" href="' + E(link) + '" target="_blank">\u2192 Source</a>' : '') +
    '</div><div id="drill-thread">' + LOADING_HTML + '<p style="color:var(--tx2);font-size:12px">Fetching article\u2026</p></div>' +
    renderDrillInput();

  try {
    var drillResp = await fetch("/api/drill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, link }),
    });
    var drillRaw = await drillResp.text();
    var data;
    try {
      data = JSON.parse(drillRaw);
    } catch (pe) {
      var cl = drillRaw.replace(/[\x00-\x1f\x7f]/g, function(c) {
        if (c === '\n' || c === '\r' || c === '\t') return ' ';
        return '';
      });
      data = JSON.parse(cl);
    }

    if (data.error) {
      $("drill-thread").innerHTML = '<div class="drill-err">' + E(data.error) + '</div>';
      return;
    }

    _drillText = data.scraped_text || "";

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

    // Auto-trigger first AI analysis
    drillAI(topic);
  } catch (err) {
    $("drill-thread").innerHTML = '<div class="drill-err">' + E(err.message) + '</div>';
  }
}

/** Build accumulated context from all prior depth levels */
function buildDrillContext() {
  return _drillThread
    .map(function(e) {
      var parts = [];
      if (e.question) parts.push("Q: " + e.question);
      if (e.ai && e.ai.title) parts.push("## " + e.ai.title);
      if (e.ai && e.ai.summary) parts.push(e.ai.summary);
      return parts.join("\n");
    })
    .join("\n\n");
}

/** Core AI call — creates a new depth entry */
async function drillAI(topic, question) {
  if (_drillBusy) { toast("AI is already processing\u2026"); return; }
  _drillBusy = true;

  const thread = $("drill-thread");
  if (!thread) { _drillBusy = false; return; }

  const context = buildDrillContext();
  const depth = _drillThread.length;

  // Disable input
  var input = $("drill-followup");
  if (input) input.disabled = true;

  // Show loading in the thread area (we'll replace it with the full re-render)
  var loadId = "drill-load-" + Date.now();
  var loadEl = document.createElement("div");
  loadEl.id = loadId;
  loadEl.className = "drill-entry drill-entry-loading";
  loadEl.innerHTML = '<div class="drill-entry-head">' +
    '<span class="drill-depth-num">' + (depth + 1) + '</span>' +
    '<span class="drill-entry-topic">' + E(question || topic) + '</span>' +
    '<span class="drill-entry-status">\u23f3 Analyzing\u2026</span></div>' +
    LOADING_HTML;
  thread.appendChild(loadEl);
  scrollDrill(loadEl);

  try {
    var payload = { topic: _drillTopic, text: _drillText, context: context };
    if (question) {
      payload.question = question;
      payload.search_query = question;
    } else if (!_drillText) {
      payload.search_query = topic;
    }

    var resp = await fetch("/api/drill/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    var rawText = await resp.text();

    // Resilient JSON parsing — handle control characters from AI
    var data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      var cleaned = rawText.replace(/[\x00-\x1f\x7f]/g, function(c) {
        if (c === '\n' || c === '\r' || c === '\t') return ' ';
        return '';
      });
      try {
        data = JSON.parse(cleaned);
      } catch (_) {
        throw new Error("JSON parse error: " + parseErr.message);
      }
    }

    if (data.error) {
      var el = $(loadId);
      if (el) {
        el.className = "drill-entry drill-entry-err";
        el.innerHTML = '<div class="drill-entry-head">' +
          '<span class="drill-depth-num err">\u26a0</span>' +
          '<span class="drill-entry-topic">' + E(topic) + '</span></div>' +
          '<div class="drill-entry-body">' + E(data.error) + '</div>';
      }
      _drillBusy = false;
      if (input) input.disabled = false;
      return;
    }

    var ai = data.ai || {};
    var newsSources = data.news_sources || [];
    var followUps = ai.follow_ups || [];

    // Only add fallback follow-ups if the AI call timed out (>180s)
    var elapsedMs = data.elapsed_ms || 0;
    if (followUps.length < 2 && elapsedMs > 180000) {
      var drillFallbacks = [
        { question: "What are the broader implications?", hint: "Impact analysis" },
        { question: "How does this connect to other recent developments?", hint: "Cross-reference" },
        { question: "What should we watch for next?", hint: "Forward-looking" },
      ];
      while (followUps.length < 2 && drillFallbacks.length > 0) {
        followUps.push(drillFallbacks.shift());
      }
    }

    // Store in thread
    _drillThread.push({
      topic: ai.title || topic,
      question: question || null,
      ai: ai,
      tokens: data.tokens || 0,
      elapsed_ms: data.elapsed_ms || 0,
      news_fetched: data.news_fetched || 0,
      news_sources: newsSources,
      follow_ups: followUps,
    });

    // Re-render the entire thread as a depth stack
    renderDrillStack();

    if (data.elapsed_ms) {
      toast((data.tokens ? data.tokens.toLocaleString() + " tok \u00b7 " : "") + fmtMs(data.elapsed_ms));
      showTime(data.elapsed_ms);
    }
    fetchUsage();
  } catch (err) {
    var el = $(loadId);
    if (el) {
      el.className = "drill-entry drill-entry-err";
      el.innerHTML = '<div class="drill-entry-body" style="color:var(--rd)">Error: ' + E(err.message) + '</div>';
    }
  }

  _drillBusy = false;
  input = $("drill-followup");
  if (input) { input.disabled = false; input.focus(); }
}

/** Render the full depth stack — collapsed past levels + expanded current */
function renderDrillStack() {
  var thread = $("drill-thread");
  if (!thread) return;

  var html = "";
  var lastIdx = _drillThread.length - 1;

  for (var i = 0; i <= lastIdx; i++) {
    var entry = _drillThread[i];
    var isCurrent = (i === lastIdx);

    if (!isCurrent) {
      // Collapsed level — clickable to go back
      html += '<div class="drill-collapsed" data-depth="' + i + '">' +
        '<span class="drill-depth-num">' + (i + 1) + '</span>' +
        '<span class="drill-collapsed-text">' +
          (entry.question ? E(entry.question) : E(entry.topic)) +
          ' \u2014 ' + E(truncText(entry.ai.summary || "", 80)) +
        '</span>' +
        '<span class="drill-collapsed-back">\u25b4</span>' +
      '</div>';
    } else {
      // Current (expanded) level
      html += renderDrillEntry(entry, i);
    }
  }

  thread.innerHTML = html;

  // Scroll the last entry into view
  var lastEntry = thread.querySelector('.drill-entry:last-of-type, .drill-paths');
  if (lastEntry) scrollDrill(lastEntry);
}

/** Render a fully expanded drill entry with path cards */
function renderDrillEntry(entry, depth) {
  var ai = entry.ai || {};
  var html = '<div class="drill-entry">';

  // Header
  html += '<div class="drill-entry-head">' +
    '<span class="drill-depth-num">' + (depth + 1) + '</span>' +
    '<span class="drill-entry-topic">' + E(ai.title || entry.topic) + '</span>' +
    '<span class="drill-entry-meta">';
  if (entry.tokens) html += entry.tokens.toLocaleString() + ' tok';
  if (entry.elapsed_ms) html += ' \u00b7 ' + fmtMs(entry.elapsed_ms);
  html += '</span>';

  // Live sources badge (clickable)
  if (entry.news_fetched > 0 && entry.news_sources && entry.news_sources.length > 0) {
    html += '<span class="drill-live-tag drill-live-clickable" data-sources=\'' +
      A(JSON.stringify(entry.news_sources)) + '\'>' +
      '\ud83d\udd0d ' + entry.news_fetched + ' live</span>';
  } else if (entry.news_fetched > 0) {
    html += '<span class="drill-live-tag">\ud83d\udd0d ' + entry.news_fetched + ' live</span>';
  }

  html += '</div>';

  // Question (if follow-up)
  if (entry.question) {
    html += '<div class="drill-entry-question">\ud83d\udcac ' + E(entry.question) + '</div>';
  }

  // Summary
  if (ai.summary) {
    html += '<div class="drill-entry-body">' + E(ai.summary) + '</div>';
  }

  // Key points
  if (ai.key_points && ai.key_points.length) {
    html += '<div class="drill-entry-points">';
    ai.key_points.forEach(function(p) {
      html += '<div class="drill-entry-point">\u2022 ' + E(p) + '</div>';
    });
    html += '</div>';
  }

  // Source pills
  if (entry.news_sources && entry.news_sources.length > 0) {
    html += '<div class="drill-source-pills">';
    var seen = {};
    entry.news_sources.forEach(function(s) {
      var name = s.source || "Source";
      if (seen[name]) return;
      seen[name] = true;
      var isLive = true;
      html += '<span class="drill-source-pill' + (isLive ? ' live' : '') + '">' + E(name) + (isLive ? ' (live)' : '') + '</span>';
    });
    html += '</div>';
  }

  html += '</div>';

  // Path cards (fortune teller branches)
  var followUps = entry.follow_ups || ai.follow_ups || [];
  if (followUps.length > 0) {
    html += '<div class="drill-paths">';
    html += '<div class="drill-paths-divider"><div class="drill-paths-line"></div><span class="drill-paths-label label-caps">Go deeper</span><div class="drill-paths-line"></div></div>';

    followUps.forEach(function(f) {
      var q = typeof f === "string" ? f : (f.question || f);
      var hint = typeof f === "object" ? (f.hint || "") : "";
      html += '<div class="drill-path-card" data-question="' + A(q) + '">' +
        '<div class="drill-path-inner">' +
        '<div><div class="drill-path-q">' + E(q) + '</div>' +
        (hint ? '<div class="drill-path-hint">' + E(hint) + '</div>' : '') +
        '</div><span class="drill-path-arrow">&#x203A;</span></div></div>';
    });

    html += '</div>';
  }

  // Also show legacy "related" topics as smaller chips if present
  var related = ai.related || [];
  if (related.length > 0 && followUps.length === 0) {
    html += '<div class="drill-entry-related">';
    related.forEach(function(r) {
      html += '<span class="chip drill-related-chip" data-related="' + A(r) + '">' + E(r) + '</span>';
    });
    html += '</div>';
  }

  return html;
}

/** Click handler: collapsed levels — go back to that depth */
document.addEventListener("click", function(e) {
  var collapsed = e.target.closest(".drill-collapsed[data-depth]");
  if (collapsed) {
    var depth = parseInt(collapsed.dataset.depth);
    // Trim thread to this depth (keep 0..depth inclusive)
    _drillThread = _drillThread.slice(0, depth + 1);
    renderDrillStack();
    return;
  }

  // Click handler: path cards — drill deeper
  var pathCard = e.target.closest(".drill-path-card[data-question]");
  if (pathCard) {
    var question = pathCard.dataset.question;
    drillAI(_drillTopic, question);
    return;
  }

  // Click handler: related chips (legacy fallback)
  var relChip = e.target.closest(".drill-related-chip[data-related]");
  if (relChip) {
    drillAI(relChip.dataset.related);
    return;
  }

  // Click handler: live sources badge — open sources modal
  var liveTag = e.target.closest(".drill-live-clickable[data-sources]");
  if (liveTag) {
    e.stopPropagation();
    try {
      var sources = JSON.parse(liveTag.dataset.sources);
      openSourcesModal(sources);
    } catch (_) {}
    return;
  }
});

/** Follow-up: user typed a question in the input */
function drillAskFollowUp() {
  var input = $("drill-followup");
  if (!input) return;
  var q = input.value.trim();
  if (!q) return;
  input.value = "";
  drillAI(_drillTopic, q);
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
  var dp = el.closest(".dp");
  if (dp) {
    setTimeout(function() { dp.scrollTo({ top: dp.scrollHeight, behavior: "smooth" }); }, 60);
  }
}

function closeDrill() {
  $("ov").classList.remove("open");
  _drillBusy = false;
}
const cdrill = closeDrill;

/** Truncate text for collapsed view */
function truncText(s, max) {
  if (!s || s.length <= max) return s || "";
  return s.substring(0, max) + "\u2026";
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCES MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function openSourcesModal(sources) {
  var overlay = $("src-ov");
  var list = $("src-list");

  var html = "";
  sources.forEach(function(s) {
    var source = s.source || "Source";
    var title = s.title || "Untitled";
    var link = s.link || "";
    html += '<div class="src-item">' +
      '<div class="src-item-source">' + E(source) + '</div>' +
      '<div class="src-item-title">' + E(title) + '</div>' +
      (link ? '<a class="src-item-link" href="' + E(link) + '" target="_blank">' + E(link.substring(0, 80)) + (link.length > 80 ? '\u2026' : '') + ' \u2192</a>' : '') +
    '</div>';
  });

  if (!sources.length) {
    html = '<div class="src-empty">No live sources available.</div>';
  }

  list.innerHTML = html;
  overlay.classList.add("open");
}

function closeSources(event) {
  if (!event || event.target.id === "src-ov") {
    $("src-ov").classList.remove("open");
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

  // Auto-scan news feeds on startup
  scan();
})();