// 润色收藏管理页：从 chrome.storage.local 的 corrections 键读取，支持搜索、朗读、删除、清空。
// 与划词收藏插件（favorites 键）相互独立，这里只管 tutor 的润色纠错。
const STORAGE_KEY = "corrections";
const listEl = document.querySelector("#list");
const listNavEl = document.querySelector("#listNav");
const countEl = document.querySelector("#count");
const searchEl = document.querySelector("#search");
const clearAllBtn = document.querySelector("#clearAll");

let allItems = [];
let studyFilter = "all";

const hasChromeStorage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

function getCorrections() {
  return new Promise((resolve, reject) => {
    const accept = value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) { reject(new Error("收藏数据格式异常，已停止修改")); return; }
      resolve(value);
    };
    if (hasChromeStorage) {
      chrome.storage.local.get(STORAGE_KEY, res => {
        if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message));
        else accept(res[STORAGE_KEY] || {});
      });
    } else {
      try { accept(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")); }
      catch (error) { reject(error); }
    }
  });
}

function setCorrections(map) {
  if (hasChromeStorage) return new Promise((resolve, reject) => chrome.storage.local.set({ [STORAGE_KEY]: map }, () => {
    if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve();
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  return Promise.resolve();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// 把构式里的 [槽位] 高亮：先转义，再把 [...] 包成高亮 span。
function highlightSlots(str) {
  return escapeHtml(str).replace(/\[([^\[\]]*)\]/g, '<span class="slot">[$1]</span>');
}



// 发音：朗读「地道说法」。优先 macOS 自带高质量美音。
const PREFERRED_VOICES = [
  "Evan（优化音质）", "Evan (Enhanced)", "Ava（高音质）", "Ava (Premium)",
  "Allison（优化音质）", "Samantha（优化音质）", "Samantha (Enhanced)", "Samantha", "Alex",
];
let cachedVoice = null;

function pickVoice() {
  if (cachedVoice) return cachedVoice;
  const synth = window.speechSynthesis;
  const voices = synth ? synth.getVoices() : [];
  if (!voices.length) return null;
  const isUS = (v) => /en[-_]US/i.test(v.lang);
  for (const name of PREFERRED_VOICES) {
    const v = voices.find((vv) => vv.name === name);
    if (v) return (cachedVoice = v);
  }
  const hq = voices.find((v) => isUS(v) && /高音质|优化音质|enhanced|premium/i.test(v.name));
  if (hq) return (cachedVoice = hq);
  return (cachedVoice = voices.find(isUS) || null);
}

if (window.speechSynthesis) {
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    cachedVoice = null;
    pickVoice();
  });
}

function speak(text) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "en-US";
    const voice = pickVoice();
    if (voice) utter.voice = voice;
    synth.speak(utter);
  } catch (_) { /* 忽略 */ }
}

// 把时间戳归到「今天 / 昨天 / 具体日期」分组标签，做时间线展示。
function dayLabel(ts) {
  if (!ts) return "更早";
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays === 2) return "前天";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 一条小评分条（场景适配最重要，<60 标红）。
function scorePill(label, val) {
  if (val == null) return "";
  let cls = "high";
  if (val < 60) cls = "low";
  else if (val < 80) cls = "mid";
  return `<span class="score-pill ${cls}">${label} ${val}</span>`;
}

function feedbackCardHtml(item) {
  const rows = Array.isArray(item.adjustments) ? item.adjustments : [];
  return `<details class="card" data-key="${escapeHtml(item.key)}">
    <summary class="card-summary"><div class="card-head"><span class="intent-title">${escapeHtml(item.sourceLabel || "本次表达调整")}</span><span class="meta">${rows.length} 处对比 · 不自动复习</span></div><p>${escapeHtml(item.personalContext || "")}</p></summary>
    <div class="card-body">${item.omitted ? `<p class="feedback-note">有 ${item.omitted} 项无法与原反馈核对或题面包含答案，未纳入记录。</p>` : ""}<p class="feedback-note">这是一份反馈记录，不是 ${rows.length} 项待办。只在近期想再用时，挑一个表达思路安排练习。</p>
      ${!item.originalParagraph ? '<p class="feedback-note">未提供完整原段落，以下只保留反馈中明确出现的原表达，不推测还原。</p>' : `<details><summary>查看原段落</summary><p class="feedback-source">${escapeHtml(item.originalParagraph)}</p></details>`}
      ${item.polishedParagraph ? `<details><summary>查看当时的润色段落</summary><p class="feedback-source">${escapeHtml(item.polishedParagraph)}</p></details>` : ""}
      ${rows.map((row,index) => {
        const child=allItems.find(it => it.key === `${item.key}:adjustment:${index}`);
        const active=child && NuanceLearning.stateOf(child)==="active";
        return `<section class="feedback-row"><span class="scene-tag">${escapeHtml(NuanceFeedback.labels[row.kind] || "表达调整")}</span>
          <p class="feedback-before">我当时写的：${escapeHtml(row.before)}</p><p class="feedback-after">这次的调整：${escapeHtml(row.after)}</p>
          <p>${escapeHtml(row.reason)}</p><p class="feedback-note">可复用的表达思路：${escapeHtml(row.pattern)}</p>
          <button class="pill" type="button" data-feedback-session="${escapeHtml(item.key)}" data-feedback-index="${index}" ${active ? "disabled" : ""}>${active ? "已安排下次试用" : "下次试用这个表达思路"}</button></section>`;
      }).join("")}
      <details><summary>查看原始 AI 反馈</summary><div class="feedback-source">${escapeHtml(item.sourceFeedback || "")}</div></details>
      <div class="card-actions"><button class="btn-del" data-remove="${escapeHtml(item.key)}">删除这份记录</button></div>
    </div></details>`;
}

function cardHtml(item) {
  if (item.origin === "feedback-session") return feedbackCardHtml(item);
  // 卡片时间戳跟日期分组一致，看 createdAt（收藏那天）；老数据回退 savedAt。
  const ts = item.createdAt || item.savedAt || 0;
  const time = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  // 卡片时间：几月几日 几时几分（日期+时刻都给全，便于回看具体哪条）
  const stamp = ts
    ? `${time.getMonth() + 1}月${time.getDate()}日 ${pad(time.getHours())}:${pad(time.getMinutes())}`
    : "";

  // 标题＝用户手写的「记忆提示」(situation)：它对这句话的唤醒能力最强，
  // 既是找回的入口线索、也是复习题面。没填才回退到原句/地道说法。
  // 机器造的 intent 暂不展示（实践表明它唤不动表达）。
  const title = item.personalContext || item.situation || item.input || item.better || "";
  const sceneTag = item.scene ? `<span class="scene-tag">${escapeHtml(item.scene)}</span>` : "";
  const toneTag = item.tone ? `<span class="tone-tag">${escapeHtml(item.tone)}语气</span>` : "";
  // 星级：0=只在接收库；1–5=产出核心（星越多越高频，练习/对练优先）。这里可改，收藏当下在 polish 页也能标。
  const studyState = NuanceLearning.stateOf(item);
  const stateLabel = { inbox: "暂存", active: "正在练", archived: "已能用 / 归档" };
  const starBox = `<span class="meta">${stateLabel[studyState]}</span>`;
  const stateControl = `<label class="study-control">学习状态 <select data-study-key="${escapeHtml(item.key)}" aria-label="学习状态：${escapeHtml(item.better)}">${Object.entries(stateLabel).map(([key, label]) => `<option value="${key}" ${key === studyState ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <button class="pill" data-edit-cue="${escapeHtml(item.key)}" type="button">编辑使用情境</button>
    ${item.sourceLabel ? `<p class="note">来源：${/^https?:\/\//.test(item.sourceUrl || "") ? `<a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.sourceLabel)}</a>` : escapeHtml(item.sourceLabel)}</p>` : ""}`;
  const inputLine = item.input && item.input !== item.better
    ? `<div class="input-line">原句：${escapeHtml(item.input)}</div>`
    : "";
  const impression = item.impression
    ? `<div class="impression">👀 ${escapeHtml(item.impression)}</div>`
    : "";
  const sc = item.scores || {};
  const scoresHtml = (sc.grammar != null || sc.idiomatic != null || sc.fitness != null)
    ? `<div class="scores">${scorePill("语法", sc.grammar)}${scorePill("地道", sc.idiomatic)}${scorePill("场景", sc.fitness)}</div>`
    : "";
  const note = item.note ? `<div class="note">${escapeHtml(item.note)}</div>` : "";
  // 可复用表达块（chunks）：固定/骨架/半固定分类 + 升级点高亮。
  // 兼容老数据：没有 chunks 但有 construct 字符串时，当单个 skeleton 块渲染。
  let chunks = Array.isArray(item.chunks) ? item.chunks : [];
  if (!chunks.length && item.construct) {
    chunks = [{ text: item.construct, type: "skeleton", label: "", isUpgrade: false }];
  }
  const typeLabel = { fixed: "固定表达", skeleton: "句型骨架", semi: "半固定" };
  const construct = chunks.length
    ? `<div class="chunks"><div class="chunks-title">可复用表达</div>${chunks
        .map((c) => {
          const t = ["fixed", "skeleton", "semi"].includes(c.type) ? c.type : "skeleton";
          const up = c.isUpgrade ? `<span class="chunk-up">✨ 你可能想不到</span>` : "";
          const label = c.label ? `<span class="chunk-label">${escapeHtml(c.label)}</span>` : "";
          return `<div class="chunk-row ${c.isUpgrade ? "upgrade" : ""}">
              <div class="chunk-text">${highlightSlots(c.text)}</div>
              <div class="chunk-meta"><span class="chunk-type ${t}">${typeLabel[t]}</span>${label}${up}</div>
            </div>`;
        })
        .join("")}</div>`
    : "";

  // 语气版本：作为展开区内容之一。每种语气一行、标签点亮、可单独朗读。
  let tonesHtml = "";
  if (Array.isArray(item.tones) && item.tones.length) {
    const rows = item.tones.map((t) =>
      `<div class="tone-row">
        <span class="tone-name">${escapeHtml(t.label)}</span>
        <span class="tone-val">${escapeHtml(t.text)}</span>
        <button class="speak tone-speak" data-speak-text="${escapeHtml(t.text)}" title="朗读">🔊</button>
      </div>`
    ).join("");
    tonesHtml = `<div class="tones-block">
      <div class="tones-title">换个语气这样说 · ${item.tones.length} 种</div>
      ${rows}
    </div>`;
  }

  // 展开区里有多少「额外信息」，用来在摘要上给个小标记（让人知道点开有货）。
  const extras = [construct, impression, scoresHtml, inputLine, note, tonesHtml].filter(Boolean).length;
  const toneCount = Array.isArray(item.tones) ? item.tones.length : 0;
  const moreHint = toneCount
    ? `<span class="more-hint">含 ${toneCount} 种语气</span>`
    : (extras ? `<span class="more-hint">展开看详情</span>` : "");

  // 整张卡片折叠：<details> 默认收起，只显示摘要（场景标签 + 意图 + 地道说法）。
  // 点标题展开才显示构式/评分/语气/笔记等，一屏能扫更多条、按需深入。
  return `
    <details class="card ${studyState === "active" ? "starred" : ""}" data-key="${escapeHtml(item.key)}">
      <summary class="card-summary">
        <div class="card-head">
          <div class="title-wrap">
            ${sceneTag}
            ${toneTag}
            <span class="intent-title">${escapeHtml(title)}</span>
          </div>
          <div class="head-right">
            ${starBox}
            <span class="meta">${stamp}</span>
          </div>
        </div>
        <div class="better">
          ${escapeHtml(item.better || "")}
          <button class="speak" data-speak="${escapeHtml(item.key)}" title="朗读">🔊</button>
        </div>
        <div class="summary-foot">
          ${moreHint}
          <span class="chevron" aria-hidden="true">▾</span>
        </div>
      </summary>
      <div class="card-body">
        ${construct}
        ${impression}
        ${scoresHtml}
        ${inputLine}
        ${note}
        ${tonesHtml}
        ${stateControl}
        <div class="card-actions">
          <button class="btn-del" data-remove="${escapeHtml(item.key)}">删除</button>
        </div>
      </div>
    </details>
  `;
}

function render(items) {
  const expressions=allItems.filter(it => it.origin !== "feedback-session");
  const active = expressions.filter(it => NuanceLearning.stateOf(it) === "active").length;
  const inbox = expressions.filter(it => NuanceLearning.stateOf(it) === "inbox").length;
  const feedbackCount=allItems.length-expressions.length;
  if (!document.querySelector("#paneCorrections").classList.contains("hidden")) countEl.textContent = `正在练 ${active} / ${NuanceLearning.ACTIVE_LIMIT} · 暂存 ${inbox} · 调整记录 ${feedbackCount} 次`;

  if (!items.length) {
    listNavEl.innerHTML = "";
    const message = allItems.length
      ? "没有匹配的收藏。"
      : "可以直接粘贴学到的表达，不必先润色。";
    listEl.innerHTML = `<div class="empty"><img src="images/mascot-comfort-v2.png" alt="Coco 正在等待你的收藏" /><span>${message}</span></div>`;
    return;
  }

  // 先按日期聚合，给每个日期一个锚点 id，供左侧目录跳转。
  const dayGroups = [];
  for (const item of items) {
    // 日期分组按 createdAt（收藏那天）；老数据/未改过的没有它，回退 savedAt。
    // 这样「换情境」等就地改动 bump 了 savedAt，也不会把卡片挪到今天。
    const label = dayLabel(item.createdAt || item.savedAt);
    let g = dayGroups.find((d) => d.label === label);
    if (!g) { g = { label, items: [], anchor: `day-anchor-${dayGroups.length}` }; dayGroups.push(g); }
    g.items.push(item);
  }

  // 左侧目录：按日期，显示日期 + 条数。
  listNavEl.innerHTML =
    `<div class="scene-nav-title">日期目录（${dayGroups.length}）</div>` +
    dayGroups
      .map(
        (g, gi) => `
        <button class="nav-item ${gi === 0 ? "active" : ""}" data-anchor="${g.anchor}">
          <span class="nav-name">${escapeHtml(g.label)}</span>
          <span class="nav-count">${g.items.length}</span>
        </button>`
      )
      .join("");

  // 每个日期一段：分隔条 + 两列网格。
  let html = "";
  for (const g of dayGroups) {
    html += `<div class="day-divider" id="${g.anchor}"><span class="day-label">${escapeHtml(g.label)}</span><span class="day-count">${g.items.length} 条</span></div>`;
    html += `<div class="cards-grid">${g.items.map(cardHtml).join("")}</div>`;
  }
  listEl.innerHTML = html;
}

function applyFilter() {
  const q = searchEl.value.trim().toLowerCase();
  let items = allItems;
  // 「只看核心」：只留星级≥1（已晋升进产出核心）的。
  if (studyFilter === "feedback") items=items.filter(it => it.origin === "feedback-session");
  else if (studyFilter !== "all") items = items.filter(it => it.origin !== "feedback-session" && NuanceLearning.stateOf(it) === studyFilter);
  if (q) {
    items = items.filter((item) => {
      const hay = `${item.situation || ""} ${item.intent || ""} ${item.scene || ""} ${item.input || ""} ${item.better || ""} ${item.note || ""} ${item.sourceLabel || ""} ${item.personalContext || ""} ${JSON.stringify(item.adjustments || [])}`;
      return hay.toLowerCase().includes(q);
    });
  }
  render(items);
}

async function load() {
  const map = await getCorrections();
  allItems = Object.entries(map)
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  applyFilter();
}

listEl.addEventListener("click", async (event) => {
  const practice=event.target.closest("[data-feedback-session]");
  if(practice){
    practice.disabled=true;
    try {
      const latest=await getCorrections();
      const result=NuanceFeedback.activate(latest,practice.dataset.feedbackSession,Number(practice.dataset.feedbackIndex),Date.now(),NuanceLearning.canActivate);
      await setCorrections(result.map);window.NuanceSync?.syncSoon();await load();
      const section=[...listEl.querySelectorAll("details[data-key]")].find(el=>el.dataset.key===practice.dataset.feedbackSession);
      if(section)section.open=true;
    } catch(error) {alert(error.message || "未能保存，请重试");practice.disabled=false;}
    return;
  }
  const edit = event.target.closest("[data-edit-cue]");
  if (edit) {
    const map = await getCorrections();
    const item = map[edit.dataset.editCue];
    if (!item) return;
    const cue = prompt("什么情况下你会想用这句话？写一个不包含英文答案的情境。", item.situation || "");
    if (cue == null || !cue.trim()) return;
    item.createdAt ||= item.savedAt || Date.now();
    item.situation = cue.trim(); item.savedAt = Date.now();
    try { await setCorrections(map); window.NuanceSync?.syncSoon(); await load(); }
    catch (_) { alert("保存失败，原数据仍保留，请检查本地存储空间。"); }
    return;
  }
  // 语气行的朗读按钮：读该语气版本自己的文本。
  const toneSpeak = event.target.closest(".tone-speak");
  if (toneSpeak) {
    speak(toneSpeak.getAttribute("data-speak-text") || "");
    return;
  }

  const speakKey = event.target.getAttribute("data-speak");
  if (speakKey) {
    const item = allItems.find((it) => it.key === speakKey);
    if (item) speak(item.better || item.input || "");
    return;
  }

  const key = event.target.getAttribute("data-remove");
  if (!key) return;
  const map = await getCorrections();
  delete map[key];
  await setCorrections(map);
  if (window.NuanceSync) window.NuanceSync.recordDelete(key);
  await load();
});

clearAllBtn.addEventListener("click", async () => {
  if (!allItems.length) return;
  if (!confirm("确定清空全部润色收藏吗？此操作不可撤销。")) return;
  const keys = allItems.map((it) => it.key);
  await setCorrections({});          // 先落地清空，避免随后 syncNow 又把旧数据传上去
  // 每个 key 记墓碑，确保清空能同步到其他设备，而不是被别端旧数据复活。
  if (window.NuanceSync) await window.NuanceSync.recordDeleteMany(keys);
  await load();
});

searchEl.addEventListener("input", applyFilter);

document.querySelector("#studyFilter").addEventListener("change", event => {
  studyFilter = event.target.value;
  applyFilter();
});

// 润色 tab 左侧日期目录：点击跳转 + 高亮。
listNavEl.addEventListener("click", (event) => {
  const item = event.target.closest(".nav-item");
  if (!item) return;
  const target = document.getElementById(item.getAttribute("data-anchor"));
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  listNavEl.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
  item.classList.add("active");
});

// 在插件里新增收藏时，实时刷新列表（仅插件环境有该 API）
if (hasChromeStorage) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEY]) load();
    if (changes[SCENE_KEY]) loadScenes();
  });
}

// 云同步写回本地后，重渲染两个 tab（拉到别的设备新增/删除的收藏）。
window.addEventListener("nuance:synced", () => { load(); loadScenes(); });

load();

// ===== tab 2：场景预演收藏 =====
// 与润色收藏(corrections)隔离，单独存在 sceneSaves 键，按「场景空间」分组展示。
const SCENE_KEY = "sceneSaves";
const tabCorrections = document.querySelector("#tabCorrections");
const tabScenes = document.querySelector("#tabScenes");
const paneCorrections = document.querySelector("#paneCorrections");
const paneScenes = document.querySelector("#paneScenes");
const sceneListEl = document.querySelector("#sceneList");
const sceneNavEl = document.querySelector("#sceneNav");
const sceneSearchEl = document.querySelector("#sceneSearch");
const clearScenesBtn = document.querySelector("#clearScenes");
const pageTitle = document.querySelector("#pageTitle");
const wrapEl = document.querySelector(".wrap");

let sceneItems = [];
// 每个场景空间各自的类型筛选：scene -> 'all' | 'phrase' | 'word'
const sceneFilters = {};

function getScenes() {
  return new Promise((resolve) => {
    if (hasChromeStorage) {
      chrome.storage.local.get(SCENE_KEY, (res) => resolve(res[SCENE_KEY] || {}));
    } else {
      try { resolve(JSON.parse(localStorage.getItem(SCENE_KEY) || "{}")); }
      catch (_) { resolve({}); }
    }
  });
}
function setScenes(map) {
  if (hasChromeStorage) return chrome.storage.local.set({ [SCENE_KEY]: map });
  try { localStorage.setItem(SCENE_KEY, JSON.stringify(map)); } catch (_) {}
  return Promise.resolve();
}

function switchTab(tab) {
  const isScenes = tab === "scenes";
  tabScenes.classList.toggle("active", isScenes);
  tabCorrections.classList.toggle("active", !isScenes);
  paneScenes.classList.toggle("hidden", !isScenes);
  paneCorrections.classList.toggle("hidden", isScenes);
  pageTitle.textContent = isScenes ? "我的场景演练收藏" : "我的表达";
}
tabCorrections.addEventListener("click", () => switchTab("corrections"));
tabScenes.addEventListener("click", () => switchTab("scenes"));

function sceneCardHtml(item) {
  const isWord = item.type === "word";
  const them = item.source === "them";
  const construct = item.construct
    ? `<div class="sc-construct">${highlightSlots(item.construct)}</div>`
    : "";
  const note = item.note ? `<div class="sc-note">${escapeHtml(item.note)}</div>` : "";
  const speakText = isWord ? item.intent : item.better;
  return `
    <div class="sc-card">
      <button class="sc-del" data-remove="${escapeHtml(item.key)}" title="删除">✕</button>
      <div class="sc-tags">
        <span class="sc-badge ${isWord ? "word" : "phrase"}">${isWord ? "单词" : "句子"}</span>
        <span class="sc-src ${them ? "them" : "me"}">${them ? "对方会说" : "我要说"}</span>
      </div>
      <div class="sc-intent">${escapeHtml(item.intent)}</div>
      <div class="sc-better-row">
        <div class="sc-better">${escapeHtml(item.better)}</div>
        <button class="speak" data-speak="${escapeHtml(item.key)}" data-text="${escapeHtml(speakText)}" title="朗读">🔊</button>
      </div>
      ${construct}
      ${note}
    </div>`;
}

function renderScenes(items) {
  if (!paneScenes.classList.contains("hidden")) countEl.textContent = `共 ${sceneItems.length} 条场景收藏`;
  if (!items.length) {
    sceneNavEl.innerHTML = "";
    const message = sceneItems.length
      ? "没有匹配的收藏。"
      : "还没有场景收藏。在「场景预演」里点卡片的 ☆ 即可收藏。";
    sceneListEl.innerHTML = `<div class="empty"><img src="images/mascot-comfort-v2.png" alt="Coco 正在等待你的场景收藏" /><span>${message}</span></div>`;
    return;
  }
  // 按场景空间分组：同一场景下的句卡/词卡聚在一起。
  const groups = new Map();
  for (const it of items) {
    const g = it.scene || "未命名场景";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  // 给每个场景一个稳定锚点 id，左侧目录点击跳转。
  const groupList = [...groups.entries()].map(([scene, cards], gi) => ({ scene, cards, anchor: `scene-anchor-${gi}` }));

  // 左侧目录：每个场景一行，显示名称 + 条数。
  sceneNavEl.innerHTML =
    `<div class="scene-nav-title">场景目录（${groupList.length}）</div>` +
    groupList
      .map(
        (g, gi) => `
        <button class="nav-item ${gi === 0 ? "active" : ""}" data-anchor="${g.anchor}">
          <span class="nav-name">${escapeHtml(g.scene)}</span>
          <span class="nav-count">${g.cards.length}</span>
        </button>`
      )
      .join("");

  let html = "";
  for (const { scene, cards, anchor } of groupList) {
    const filter = sceneFilters[scene] || "all";
    const phraseN = cards.filter((c) => c.type !== "word").length;
    const wordN = cards.filter((c) => c.type === "word").length;
    const shown = cards.filter((c) =>
      filter === "all" ? true : filter === "word" ? c.type === "word" : c.type !== "word"
    );
    const fbtn = (val, label, n) =>
      `<button class="sc-filter-btn ${filter === val ? "active" : ""}" data-scene-filter="${escapeHtml(scene)}" data-val="${val}">${label} ${n}</button>`;
    html += `
      <div class="scene-group" id="${anchor}">
        <div class="scene-group-head">
          <span class="scene-group-title">${escapeHtml(scene)}</span>
          <span class="scene-group-count">${cards.length} 条</span>
          <div class="sc-filter">
            ${fbtn("all", "全部", cards.length)}
            ${fbtn("phrase", "句子", phraseN)}
            ${fbtn("word", "单词", wordN)}
          </div>
          <span class="spacer" style="flex:1"></span>
          <a class="sc-rehearse" href="chat.html?scene=${encodeURIComponent(scene)}" target="_blank" title="进入这个场景的对练">▶ 进入对练</a>
          <button class="sc-scene-del" data-scene-del="${escapeHtml(scene)}" title="删除整个场景（含全部卡片）">🗑 删除场景</button>
        </div>
        <div class="sc-cards">${shown.map(sceneCardHtml).join("")}</div>
      </div>`;
  }
  sceneListEl.innerHTML = html;
}

function applySceneFilter() {
  const q = sceneSearchEl.value.trim().toLowerCase();
  if (!q) return renderScenes(sceneItems);
  const filtered = sceneItems.filter((it) => {
    const hay = `${it.scene || ""} ${it.intent || ""} ${it.better || ""} ${it.construct || ""} ${it.note || ""}`;
    return hay.toLowerCase().includes(q);
  });
  renderScenes(filtered);
}

async function loadScenes() {
  const map = await getScenes();
  sceneItems = Object.entries(map)
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  applySceneFilter();
}

sceneListEl.addEventListener("click", async (event) => {
  // 场景内类型筛选：只重渲染，不动数据。
  const filterBtn = event.target.closest(".sc-filter-btn");
  if (filterBtn) {
    sceneFilters[filterBtn.getAttribute("data-scene-filter")] = filterBtn.getAttribute("data-val");
    applySceneFilter();
    return;
  }
  const speakBtn = event.target.closest(".speak");
  if (speakBtn) {
    speak(speakBtn.getAttribute("data-text") || "");
    return;
  }
  // 删除整个场景：一次性删掉该场景下所有卡片（含各自墓碑，保证多端同步删除）。
  const sceneDelBtn = event.target.closest(".sc-scene-del");
  if (sceneDelBtn) {
    const scene = sceneDelBtn.getAttribute("data-scene-del");
    const victims = sceneItems.filter((it) => (it.scene || "未命名场景") === scene);
    if (!victims.length) return;
    if (!confirm(`确定删除「${scene}」整个场景吗？将移除其下全部 ${victims.length} 张卡片，此操作不可撤销。`)) return;
    const map = await getScenes();
    victims.forEach((it) => delete map[it.key]);
    await setScenes(map);            // 先落地删除，避免随后的 syncNow 把旧数据又传上去
    delete sceneFilters[scene];
    // 一次性记全部墓碑再上行：确保多端同步删除，且不被别端旧数据复活。
    if (window.NuanceSync) await window.NuanceSync.recordDeleteMany(victims.map((it) => it.key));
    await loadScenes();
    return;
  }
  const delBtn = event.target.closest(".sc-del");
  if (!delBtn) return;
  const key = delBtn.getAttribute("data-remove");
  const map = await getScenes();
  delete map[key];
  await setScenes(map);
  if (window.NuanceSync) window.NuanceSync.recordDelete(key);
  await loadScenes();
});

clearScenesBtn.addEventListener("click", async () => {
  if (!sceneItems.length) return;
  if (!confirm("确定清空全部场景收藏吗？此操作不可撤销。")) return;
  const keys = sceneItems.map((it) => it.key);
  await setScenes({});               // 先落地清空，避免随后 syncNow 又把旧数据传上去
  if (window.NuanceSync) await window.NuanceSync.recordDeleteMany(keys);
  await loadScenes();
});

sceneSearchEl.addEventListener("input", applySceneFilter);

// 左侧目录点击：平滑滚动到对应场景，并高亮该目录项。
sceneNavEl.addEventListener("click", (event) => {
  const item = event.target.closest(".nav-item");
  if (!item) return;
  const anchor = item.getAttribute("data-anchor");
  const target = document.getElementById(anchor);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  sceneNavEl.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
  item.classList.add("active");
});

// 滚动联动：滚到哪个分组，左侧目录就高亮哪个（scroll-spy）。两个 tab 各自联动。
let spyTicking = false;
function spyHighlight(nav, groupEls) {
  if (!groupEls.length) return;
  let currentId = groupEls[0].id;
  for (const g of groupEls) {
    if (g.getBoundingClientRect().top <= 120) currentId = g.id;
  }
  nav.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-anchor") === currentId);
  });
}
window.addEventListener("scroll", () => {
  if (spyTicking) return;
  spyTicking = true;
  requestAnimationFrame(() => {
    spyTicking = false;
    if (!paneScenes.classList.contains("hidden")) {
      spyHighlight(sceneNavEl, [...sceneListEl.querySelectorAll(".scene-group")]);
    } else {
      spyHighlight(listNavEl, [...listEl.querySelectorAll(".day-divider")]);
    }
  });
});

loadScenes();

// Direct capture is deliberately local: no polish request and no rewrite.
const captureText = document.querySelector("#captureText");
const capturePreview = document.querySelector("#capturePreview");
const captureStatus = document.querySelector("#captureStatus");
const saveCapture = document.querySelector("#saveCapture");
let captureRows = [];
function invalidateCapture() { captureRows = []; capturePreview.innerHTML = ""; saveCapture.hidden = true; }
captureText.addEventListener("input", invalidateCapture);
document.querySelector("#previewCapture").addEventListener("click", async () => {
  captureRows = NuanceLearning.parse(captureText.value);
  if (captureRows.length > 200) { captureStatus.textContent = "一次最多 200 条，请分批加入。"; invalidateCapture(); return; }
  const map = await getCorrections();
  capturePreview.innerHTML = captureRows.map((row, i) => {
    const exists = Object.hasOwn(map, NuanceLearning.keyOf(row.expression));
    return `<label class="capture-row"><input type="checkbox" data-capture-index="${i}" ${exists ? "disabled" : "checked"} /> ${escapeHtml(row.expression)} ${exists ? "（已存在，保留原记录）" : ""}${row.cue ? `<br/><small>${escapeHtml(row.cue)}</small>` : ""}</label>`;
  }).join("");
  saveCapture.hidden = !captureRows.some(row => !Object.hasOwn(map, NuanceLearning.keyOf(row.expression)));
  captureStatus.textContent = captureRows.length ? "取消勾选不想留下的表达。重复项不会覆盖已有内容或进度。" : "请先粘贴至少一条表达。";
});
saveCapture.addEventListener("click", async () => {
  saveCapture.disabled = true;
  try {
    const latest = await getCorrections(); // Re-read after preview; never overwrite an existing record.
    const selected = [...capturePreview.querySelectorAll("input:checked:not(:disabled)")].map(checkbox => captureRows[Number(checkbox.dataset.captureIndex)]);
    const { map, added } = NuanceLearning.addRows(latest, selected, document.querySelector("#captureSource").value, Date.now());
    if (!added) { captureStatus.textContent = "没有选中新的表达。"; return; }
    await setCorrections(map);
    window.NuanceSync?.syncSoon();
    captureText.value = ""; invalidateCapture(); await load();
    captureStatus.textContent = `已在本机暂存 ${added} 条。云同步成功后会显示确认；从列表中选择少量表达设为「正在练」。`;
  } catch (_) { captureStatus.textContent = "未能保存，请保留输入并检查本地存储空间。"; }
  finally { saveCapture.disabled = false; }
});
window.addEventListener("nuance:synced", () => { if (captureStatus.textContent.startsWith("已在本机暂存")) captureStatus.textContent = "已同步到云端。挑少量表达开始练习即可。"; });
window.addEventListener("nuance:sync-error", () => { captureStatus.textContent = "云同步暂未完成；已保存的表达仍在本机，稍后重试。"; });
listEl.addEventListener("change", async event => {
  const control = event.target.closest("[data-study-key]");
  if (!control) return;
  try {
    const map = await getCorrections(), item = map[control.dataset.studyKey];
    if (!item) return;
    const next = control.value;
    if (next === "active" && NuanceLearning.stateOf(item) !== "active") {
      if (!NuanceLearning.canActivate(map, item)) {
        alert("正在练的表达已有 20 条。先将暂时不需要的表达移回暂存或归档，再加入新的。已有数据不会被移除。"); await load(); return;
      }
      if (!item.situation && !item.intent) {
        const cue = prompt("什么情况下你会想用这句话？补充一个中文情境，练习时不会显示答案。", "");
        if (!cue?.trim()) { await load(); return; }
        item.situation = cue.trim();
      }
    }
    item.createdAt ||= item.savedAt || Date.now();
    item.studyState = next; item.savedAt = Date.now();
    await setCorrections(map); window.NuanceSync?.syncSoon(); await load();
  } catch (_) { alert("状态未保存，请检查本地存储空间后重试。"); await load(); }
});

// Record a whole coaching feedback as one session, without manufacturing a full original paragraph.
const feedbackText=document.querySelector("#feedbackText");
const feedbackStatus=document.querySelector("#feedbackStatus");
const saveFeedback=document.querySelector("#saveFeedback");
saveFeedback.addEventListener("click", async()=>{
  const text=feedbackText.value.trim();
  if(text.length<20||text.length>20000){feedbackStatus.textContent="请粘贴包含对比部分的完整反馈（20～20000 字符）。";return;}
  saveFeedback.disabled=true;
  feedbackStatus.textContent="正在整理原表达、调整与原因，不会重新润色你的段落…";
  try {
    const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
    const id=Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,"0")).join("");
    const key="feedback:"+id;
    let latest=await getCorrections();
    if(!Object.hasOwn(latest,key)){
      const response=await fetch(`${window.NUANCE_MODEL_ORIGIN || location.origin}/feedback`,{
        method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text}),signal:AbortSignal.timeout(150000)
      });
      const result=await response.json();if(!response.ok)throw new Error(result.error||"整理失败，请重试");
      const data=NuanceFeedback.validate(result,text);if(data && Number.isInteger(result.omitted))data.omitted=result.omitted;if(!data)throw new Error("返回内容无法与原反馈核对，没有保存。请重试。");
      latest=await getCorrections();
      if(!Object.hasOwn(latest,key)){
        const title=document.querySelector("#feedbackTitle").value.trim()||`每日英语 · ${new Date().toLocaleDateString("zh-CN")}`;
        Object.defineProperty(latest,key,{value:NuanceFeedback.session(data,text,title,id,Date.now()),enumerable:true,writable:true,configurable:true});
        await setCorrections(latest);window.NuanceSync?.syncSoon();
      }
      feedbackStatus.textContent=`已在本机记下这次反馈的 ${data.adjustments.length} 处调整，没有增加复习任务。`;
    } else feedbackStatus.textContent="这份反馈已经记录过，已为你打开，没有重复新增或覆盖原记录。";
    studyFilter="feedback";document.querySelector("#studyFilter").value="feedback";await load();
    const card=[...listEl.querySelectorAll("details[data-key]")].find(el=>el.dataset.key===key);
    if(card){card.open=true;card.scrollIntoView({behavior:"smooth",block:"start"});}
    if(feedbackText.value.trim()===text)feedbackText.value="";
  } catch(error){feedbackStatus.textContent=error.message||"未能记录，请保留粘贴的内容后重试。";}
  finally{saveFeedback.disabled=false;}
});
window.addEventListener("nuance:synced",()=>{if(feedbackStatus.textContent.startsWith("已在本机记下"))feedbackStatus.textContent=feedbackStatus.textContent.replace("已在本机记下","已同步保存");});

// A deliberate paste/file choice is the only image input; never poll the clipboard.
let imageFeedbackBusy=false;
async function recordFeedbackImage(file){
  if(imageFeedbackBusy)return;
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5*1024*1024){feedbackStatus.textContent='请使用不超过 5 MB 的 PNG、JPEG 或 WebP 图片';return;}
  imageFeedbackBusy=true;saveFeedback.disabled=true;feedbackStatus.textContent='正在识别截图并整理对比…';
  try{
    const image=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('图片读取失败'));r.readAsDataURL(file);});
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(image));
    const id=Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join(''),key='feedback-image:'+id;
    let latest=await getCorrections();
    if(!Object.hasOwn(latest,key)){
      const response=await fetch(`${window.NUANCE_MODEL_ORIGIN||location.origin}/feedback-image`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image}),signal:AbortSignal.timeout(110000)});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'图片识别失败');
      const data=NuanceFeedback.validate(result,result.extractedText);if(!data)throw new Error('识别结果不完整，没有保存');
      latest=await getCorrections();
      if(!Object.hasOwn(latest,key)){latest[key]=NuanceFeedback.session(data,result.extractedText,document.querySelector('#feedbackTitle').value.trim()||'截图中的表达调整',id,Date.now());await setCorrections(latest);window.NuanceSync?.syncSoon();}
    }
    feedbackStatus.textContent=`已在本机记下 ${latest[key].adjustments.length} 组调整，请核对识别文字。没有增加复习任务。`;
    studyFilter='feedback';document.querySelector('#studyFilter').value='feedback';await load();
    const card=[...listEl.querySelectorAll('details[data-key]')].find(el=>el.dataset.key===key);if(card){card.open=true;card.scrollIntoView({behavior:'smooth',block:'start'});}
  }catch(error){feedbackStatus.textContent=error.message||'识别失败，请重试';}
  finally{imageFeedbackBusy=false;saveFeedback.disabled=false;document.querySelector('#feedbackImage').value='';}
}
document.querySelector('#feedbackImage').addEventListener('change',event=>{if(event.target.files[0])recordFeedbackImage(event.target.files[0]);});
feedbackText.addEventListener('paste',event=>{const file=[...event.clipboardData.items].find(x=>x.kind==='file'&&x.type.startsWith('image/'))?.getAsFile();if(file){event.preventDefault();recordFeedbackImage(file);}});
