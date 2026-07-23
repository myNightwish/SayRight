// 润色收藏管理页：从 chrome.storage.local 的 corrections 键读取，支持搜索、朗读、删除、清空。
// 与划词收藏插件（favorites 键）相互独立，这里只管 tutor 的润色纠错。
const STORAGE_KEY = "corrections";
const listEl = document.querySelector("#list");
const listNavEl = document.querySelector("#listNav");
const countEl = document.querySelector("#count");
const searchEl = document.querySelector("#search");
const clearAllBtn = document.querySelector("#clearAll");

let allItems = [];

const hasChromeStorage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

function getCorrections() {
  return new Promise((resolve) => {
    if (hasChromeStorage) {
      chrome.storage.local.get(STORAGE_KEY, (res) => resolve(res[STORAGE_KEY] || {}));
    } else {
      try { resolve(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")); }
      catch (_) { resolve({}); }
    }
  });
}

function setCorrections(map) {
  if (hasChromeStorage) return chrome.storage.local.set({ [STORAGE_KEY]: map });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (_) {}
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

function cardHtml(item) {
  const time = new Date(item.savedAt || 0);
  const pad = (n) => String(n).padStart(2, "0");
  // 卡片时间：几月几日 几时几分（日期+时刻都给全，便于回看具体哪条）
  const stamp = item.savedAt
    ? `${time.getMonth() + 1}月${time.getDate()}日 ${pad(time.getHours())}:${pad(time.getMinutes())}`
    : "";

  // 标题优先用「表达意图」，没有则回退到原句——收藏的是"我以后想怎么表达"。
  const title = item.intent || item.input || item.better || "";
  const sceneTag = item.scene ? `<span class="scene-tag">${escapeHtml(item.scene)}</span>` : "";
  const toneTag = item.tone ? `<span class="tone-tag">${escapeHtml(item.tone)}语气</span>` : "";
  const inputLine = item.input
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

  // 语气版本（折叠在卡片底部，按需查看）
  let tonesHtml = "";
  if (Array.isArray(item.tones) && item.tones.length) {
    const rows = item.tones.map((t) =>
      `<div class="tone-row"><span class="tone-name">${escapeHtml(t.label)}</span><span class="tone-val">${escapeHtml(t.text)}</span></div>`
    ).join("");
    tonesHtml = `<details class="tones-fold"><summary>其它语气（${item.tones.length}）</summary>${rows}</details>`;
  }

  return `
    <div class="card" data-key="${escapeHtml(item.key)}">
      <div class="card-head">
        <div class="title-wrap">
          ${sceneTag}
          ${toneTag}
          <span class="intent-title">${escapeHtml(title)}</span>
        </div>
        <span class="meta">${stamp}</span>
      </div>
      <div class="better">
        ${escapeHtml(item.better || "")}
        <button class="speak" data-speak="${escapeHtml(item.key)}" title="朗读">🔊</button>
      </div>
      ${construct}
      ${impression}
      ${scoresHtml}
      ${inputLine}
      ${note}
      ${tonesHtml}
      <div class="card-actions">
        <button class="btn-del" data-remove="${escapeHtml(item.key)}">删除</button>
      </div>
    </div>
  `;
}

function render(items) {
  countEl.textContent = `共 ${allItems.length} 条润色收藏`;

  if (!items.length) {
    listNavEl.innerHTML = "";
    listEl.innerHTML = `<div class="empty">${allItems.length ? "没有匹配的收藏。" : "还没有润色收藏。在插件里润色一句话后，点结果区的 ☆ 即可收藏。"}</div>`;
    return;
  }

  // 先按日期聚合，给每个日期一个锚点 id，供左侧目录跳转。
  const dayGroups = [];
  for (const item of items) {
    const label = dayLabel(item.savedAt);
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
  if (!q) {
    render(allItems);
    return;
  }
  const filtered = allItems.filter((item) => {
    const hay = `${item.intent || ""} ${item.scene || ""} ${item.input || ""} ${item.better || ""} ${item.note || ""}`;
    return hay.toLowerCase().includes(q);
  });
  render(filtered);
}

async function load() {
  const map = await getCorrections();
  allItems = Object.entries(map)
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  applyFilter();
}

listEl.addEventListener("click", async (event) => {
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
  await load();
});

clearAllBtn.addEventListener("click", async () => {
  if (!allItems.length) return;
  if (!confirm("确定清空全部润色收藏吗？此操作不可撤销。")) return;
  await setCorrections({});
  await load();
});

searchEl.addEventListener("input", applyFilter);

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
  pageTitle.textContent = isScenes ? "我的场景演练收藏" : "我的收藏";
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
  countEl.textContent = `共 ${sceneItems.length} 条场景收藏`;
  if (!items.length) {
    sceneNavEl.innerHTML = "";
    sceneListEl.innerHTML = `<div class="empty">${
      sceneItems.length ? "没有匹配的收藏。" : "还没有场景收藏。在「场景预演」里点卡片的 ☆ 即可收藏。"
    }</div>`;
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
  const delBtn = event.target.closest(".sc-del");
  if (!delBtn) return;
  const key = delBtn.getAttribute("data-remove");
  const map = await getScenes();
  delete map[key];
  await setScenes(map);
  await loadScenes();
});

clearScenesBtn.addEventListener("click", async () => {
  if (!sceneItems.length) return;
  if (!confirm("确定清空全部场景收藏吗？此操作不可撤销。")) return;
  await setScenes({});
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
