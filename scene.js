// scene.js — 场景预演前端
// 输入一个未来场景 → 调本地 /scene → 渲染「对话剧本 + 抽卡」两段。
// 历史话题缓存在 localStorage，刷新不丢；对练在独立页 chat.html 打开。

// 接口地址跟随页面来源：经 server 托管访问（http://电脑IP:8770/scene.html）时取 location.origin，
// 手机和电脑共用一份、无需手填 IP；file:// 直接打开时回退本机。
const SERVER_ORIGIN = location.protocol.startsWith("http") ? location.origin : "http://127.0.0.1:8770";
const API = `${SERVER_ORIGIN}/scene`;
const EXTRACT_API = `${SERVER_ORIGIN}/extract`;
// 场景预演收藏：存在 chrome.storage.local 的 sceneSaves 键下，与润色收藏(corrections)、
// 划词收藏(favorites)互相隔离——不同插件功能的数据各存各的键，收藏页按 tab 分开展示。
const STORAGE_KEY = "sceneSaves";
// 场景完整剧本：按场景名存一份完整有序剧本（收藏任意一句时落库），
// 让从收藏页进对练时能拿到原汁原味的有序剧本，而不是用散卡片乱序硬拼。
const SCRIPT_KEY = "sceneScripts";
// 预演历史：缓存搜索过的话题 + 结果（剧本/卡片），存 localStorage，同场景只留最新。
const HISTORY_KEY = "sceneHistory";
// 对练剧本交接：进入 chat.html 前把当前剧本写到这里，chat 页读取。
const CHAT_HANDOFF_KEY = "chatHandoff";

// 发音：朗读英文。优先 macOS 自带高质量美音（与收藏页/复习页一致）。
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
    if (!synth || !text) return;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "en-US";
    const voice = pickVoice();
    if (voice) utter.voice = voice;
    synth.speak(utter);
  } catch (_) { /* 忽略 */ }
}

// 收藏读写：插件环境用 chrome.storage（与收藏页同源、可在 collection 看到）；
// 非插件环境（电脑经 server 托管访问）退到 localStorage，保证收藏能持久保存。
const hasChromeStorage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
function getSaves() {
  return new Promise((resolve) => {
    if (hasChromeStorage) {
      chrome.storage.local.get(STORAGE_KEY, (res) => resolve(res[STORAGE_KEY] || {}));
    } else {
      try { resolve(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")); }
      catch (_) { resolve({}); }
    }
  });
}
function setSaves(map) {
  if (hasChromeStorage) return chrome.storage.local.set({ [STORAGE_KEY]: map });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (_) {}
  return Promise.resolve();
}
const canPersist = hasChromeStorage || typeof localStorage !== "undefined";
// 收藏键：场景 + better 唯一定位一张卡，避免重复收藏。
function saveKey(scene, card) {
  return `${scene}||${card.better}`;
}

// ---- 场景完整剧本（sceneScripts，按场景名索引）----
function getScripts() {
  return new Promise((resolve) => {
    if (hasChromeStorage) {
      chrome.storage.local.get(SCRIPT_KEY, (res) => resolve(res[SCRIPT_KEY] || {}));
    } else {
      try { resolve(JSON.parse(localStorage.getItem(SCRIPT_KEY) || "{}")); }
      catch (_) { resolve({}); }
    }
  });
}
function setScripts(map) {
  if (hasChromeStorage) return chrome.storage.local.set({ [SCRIPT_KEY]: map });
  try { localStorage.setItem(SCRIPT_KEY, JSON.stringify(map)); } catch (_) {}
  return Promise.resolve();
}
// 收藏某场景任意一句时调用：把当前完整剧本落库（供对练当主线）。
// 用「新剧本更长就覆盖」而非「存过就跳过」——避免早先存了残缺剧本后再也更新不了。
async function ensureScriptSaved() {
  if (!currentScene || !currentTurns.length) return;
  const map = await getScripts();
  const existing = map[currentScene];
  const existingLen = existing && Array.isArray(existing.dialogue) ? existing.dialogue.length : 0;
  if (existingLen >= currentTurns.length) return; // 已有的同样全或更全，不动
  map[currentScene] = {
    scene: currentScene,
    dialogue: currentTurns.map((t) => ({ speaker: t.speaker, text: t.text, zh: t.zh || "" })),
    savedAt: Date.now(),
  };
  await setScripts(map);
}

// ---- 预演历史（localStorage，同场景只留最新）----
function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
  catch (_) { return []; }
}
function setHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (_) {}
}
// 写入一条历史：{ scene, dialogue, cards, at }。同名场景覆盖并提到最前。
function pushHistory(scene, dialogue, cards) {
  const list = getHistory().filter((h) => h.scene !== scene);
  list.unshift({ scene, dialogue, cards, at: Date.now() });
  setHistory(list.slice(0, 30)); // 最多留 30 条，足够用
  renderHistory();
}

const sceneInput = document.getElementById("sceneInput");
const goBtn = document.getElementById("goBtn");
const chips = document.getElementById("chips");
const historyEl = document.getElementById("history");
const statusEl = document.getElementById("status");
const stage = document.getElementById("stage");
const sceneLabel = document.getElementById("sceneLabel");
const dialogueEl = document.getElementById("dialogue");
const cardsEl = document.getElementById("cards");
const saveAllBtn = document.getElementById("saveAllBtn");
const startChatBtn = document.getElementById("startChatBtn");
const toastEl = document.getElementById("toast");

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
}

function setStatus(msg) {
  if (!msg) {
    statusEl.classList.add("hidden");
    return;
  }
  statusEl.textContent = msg;
  statusEl.classList.remove("hidden");
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 「你」开头的说话人渲染成右侧高亮气泡。
function isLearner(speaker) {
  return /你|我|学员|learner|me/i.test(speaker || "");
}

// 当前场景的标签、剧本与卡片，供收藏时构造存储项。
let currentScene = "";
let currentTurns = [];
let currentCards = [];
let savedKeys = new Set();

function renderDialogue(scene, turns) {
  sceneLabel.textContent = scene || "你的场景";
  currentTurns = turns;
  dialogueEl.innerHTML = turns
    .map((t, i) => {
      const me = isLearner(t.speaker);
      const zh = t.zh ? `<div class="zh">${escapeHtml(t.zh)}</div>` : "";
      // 这句若已经收藏过（按 场景+原句 命中），点亮星标。
      const saved = savedKeys.has(`${currentScene}||${t.text}`);
      return `
        <div class="turn ${me ? "me" : "them"}">
          <div class="who">${escapeHtml(t.speaker)}</div>
          <div class="bubble">
            <div class="bubble-head">
              <div class="en">${escapeHtml(t.text)}</div>
              <div class="bubble-actions">
                <button class="b-save ${saved ? "saved" : ""}" data-i="${i}" title="收藏这句">${saved ? "★" : "☆"}</button>
                <button class="speak" data-text="${escapeHtml(t.text)}" title="朗读">🔊</button>
              </div>
            </div>
            ${zh}
          </div>
        </div>`;
    })
    .join("");

  dialogueEl.querySelectorAll(".speak").forEach((btn) => {
    btn.addEventListener("click", () => speak(btn.getAttribute("data-text")));
  });
  // 剧本句收藏：现场调 /extract 抽成卡再落库（这句可能不在右侧卡片里）。
  dialogueEl.querySelectorAll(".b-save").forEach((btn) => {
    btn.addEventListener("click", () => saveLine(Number(btn.getAttribute("data-i")), btn));
  });
}

// 收藏剧本里的某一句：先调 /extract 现场抽卡，再写入 sceneSaves。
// 去重键用「场景+原句」，避免同一句重复收藏；再次点击取消。
async function saveLine(index, btn) {
  const turn = currentTurns[index];
  if (!turn) return;
  const lineKey = `${currentScene}||${turn.text}`;
  const map = await getSaves();
  if (map[lineKey]) {
    delete map[lineKey];
    savedKeys.delete(lineKey);
    btn.classList.remove("saved");
    btn.textContent = "☆";
    await setSaves(map);
    toast(canPersist ? "已取消收藏" : "已取消（未能保存）");
    return;
  }
  if (btn.classList.contains("saving")) return;
  btn.classList.add("saving");
  btn.textContent = "⋯";
  try {
    const resp = await fetch(EXTRACT_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene: currentScene, speaker: turn.speaker, text: turn.text }),
    });
    const card = await resp.json();
    if (!resp.ok) {
      toast(card.error || "抽卡失败，请重试");
      btn.classList.remove("saving");
      btn.textContent = "☆";
      return;
    }
    const fresh = await getSaves();
    fresh[lineKey] = {
      scene: currentScene,
      type: card.type,
      source: card.source,
      intent: card.intent,
      better: card.better,
      construct: card.construct,
      note: card.note,
      savedAt: Date.now(),
    };
    savedKeys.add(lineKey);
    await setSaves(fresh);
    await ensureScriptSaved();
    btn.classList.remove("saving");
    btn.classList.add("saved");
    btn.textContent = "★";
    toast(canPersist ? "已收藏到「场景预演」" : "已收藏（未能保存）");
  } catch (_) {
    btn.classList.remove("saving");
    btn.textContent = "☆";
    toast("连不上本地服务，无法抽卡");
  }
}

function renderCards(cards) {
  cardsEl.innerHTML = cards
    .map((c, i) => {
      const isWord = c.type === "word";
      const badge = isWord ? "单词" : "句子";
      // 来源：me = 你要说的，them = 对方会说的（需要听懂/预期的）
      const them = c.source === "them";
      const srcLabel = them ? "对方会说" : "我要说";
      const construct = c.construct
        ? `<div class="construct">${escapeHtml(c.construct)}</div>`
        : "";
      const note = c.note ? `<div class="note">${escapeHtml(c.note)}</div>` : "";
      const saved = savedKeys.has(saveKey(currentScene, c));
      // 单词卡读英文词(intent)，句卡读 better。
      const speakText = isWord ? c.intent : c.better;
      return `
        <div class="card ${isWord ? "word" : "phrase"}">
          <button class="save ${saved ? "saved" : ""}" data-i="${i}" title="收藏">${saved ? "★" : "☆"}</button>
          <div class="card-tags">
            <span class="badge">${badge}</span>
            <span class="src ${them ? "them" : "me"}">${srcLabel}</span>
          </div>
          <div class="intent">${escapeHtml(c.intent)}</div>
          <div class="better-row">
            <div class="better">${escapeHtml(c.better)}</div>
            <button class="speak" data-text="${escapeHtml(speakText)}" title="朗读">🔊</button>
          </div>
          ${construct}
          ${note}
        </div>`;
    })
    .join("");

  cardsEl.querySelectorAll(".speak").forEach((btn) => {
    btn.addEventListener("click", () => speak(btn.getAttribute("data-text")));
  });

  // 收藏：真正落库到 sceneSaves 键，按 场景+better 去重，再次点击取消收藏。
  cardsEl.querySelectorAll(".save").forEach((btn) => {
    btn.addEventListener("click", () => toggleSave(Number(btn.getAttribute("data-i")), btn));
  });
}

async function toggleSave(index, btn) {
  const card = currentCards[index];
  if (!card) return;
  const key = saveKey(currentScene, card);
  const map = await getSaves();
  if (map[key]) {
    delete map[key];
    savedKeys.delete(key);
    btn.classList.remove("saved");
    btn.textContent = "☆";
    await setSaves(map);
    toast(canPersist ? "已取消收藏" : "已取消（未能保存）");
  } else {
    map[key] = {
      scene: currentScene,
      type: card.type,
      source: card.source,
      intent: card.intent,
      better: card.better,
      construct: card.construct,
      note: card.note,
      savedAt: Date.now(),
    };
    savedKeys.add(key);
    btn.classList.add("saved");
    btn.textContent = "★";
    await setSaves(map);
    await ensureScriptSaved();
    toast(canPersist ? "已收藏到「场景预演」" : "已收藏（未能保存）");
  }
}

// 一键收藏：把右侧全部卡片一次性写入（已收藏的跳过）。
async function saveAllCards() {
  if (!currentCards.length) return;
  saveAllBtn.disabled = true;
  const map = await getSaves();
  // 剧本原句集合：卡片 better 命中其中某句时，额外用「场景+剧本原句」键存一份，
  // 让左侧剧本对应那句的星标也能点亮（剧本句收藏用的就是这个键）。
  const scriptTexts = new Set(currentTurns.map((t) => t.text));
  let added = 0;
  for (const card of currentCards) {
    const key = saveKey(currentScene, card);
    if (!map[key]) {
      map[key] = {
        scene: currentScene,
        type: card.type,
        source: card.source,
        intent: card.intent,
        better: card.better,
        construct: card.construct,
        note: card.note,
        savedAt: Date.now(),
      };
      savedKeys.add(key);
      added++;
    }
    // better 恰好等于某条剧本原句 → 同步写入剧本句键并点亮左侧星标。
    if (scriptTexts.has(card.better)) {
      const lineKey = `${currentScene}||${card.better}`;
      if (!map[lineKey]) {
        map[lineKey] = { ...map[key] };
      }
      savedKeys.add(lineKey);
    }
  }
  await setSaves(map);
  // 无条件落库完整剧本（ensureScriptSaved 内部按「更长才覆盖」去重），
  // 不依赖本次是否新增卡片——保证一键收藏后剧本一定是完整的那份。
  await ensureScriptSaved();
  // 同时重渲染右侧卡片和左侧剧本，让两边星标都按最新 savedKeys 点亮。
  renderCards(currentCards);
  renderDialogue(currentScene, currentTurns);
  saveAllBtn.disabled = false;
  if (!canPersist) toast("已收藏（未能保存）");
  else toast(added ? `已收藏 ${added} 条到「场景预演」` : "这些都已经收藏过了");
}

async function rehearse(scene) {
  const value = (scene || "").trim();
  if (!value) {
    toast("先说一个你要面对的场景");
    return;
  }
  goBtn.disabled = true;
  stage.classList.add("hidden");
  setStatus("正在为你预演这场对话……（首次约 10s，之后更快）");

  try {
    const resp = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene: value }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setStatus(data.error || "生成失败，请重试。");
      return;
    }
    setStatus("");
    currentScene = data.scene || value;
    currentCards = data.cards || [];
    currentTurns = data.dialogue || [];
    // 拉一次已收藏键，渲染时点亮已收藏的卡。
    const map = await getSaves();
    savedKeys = new Set(Object.keys(map));
    renderDialogue(currentScene, currentTurns);
    renderCards(currentCards);
    stage.classList.remove("hidden");
    // 缓存这次结果到历史话题（同场景覆盖、提到最前），刷新后可直接点开。
    pushHistory(currentScene, currentTurns, currentCards);
  } catch (err) {
    setStatus("连不上本地服务，请确认 tutor-server.mjs 已启动（node tutor-server.mjs）。");
  } finally {
    goBtn.disabled = false;
  }
}

goBtn.addEventListener("click", () => rehearse(sceneInput.value));
saveAllBtn.addEventListener("click", saveAllCards);
startChatBtn.addEventListener("click", openChat);
startChatBtn.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openChat(); }
});
sceneInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") rehearse(sceneInput.value);
});
chips.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  sceneInput.value = chip.textContent.trim();
  rehearse(sceneInput.value);
});

// 进入对练：把当前场景 + 剧本交接给独立页 chat.html（localStorage 传递），新标签打开。
function openChat() {
  if (!currentScene) {
    toast("先预演一个场景");
    return;
  }
  // 交接当前完整剧本给 chat 页。带时间戳，chat 只认「刚刚写入」的这份，
  // 用完即焚——避免残留 handoff 劫持之后从收藏页进入的对练。
  const handoff = {
    scene: currentScene,
    script: currentTurns.map((t) => ({ speaker: t.speaker, text: t.text })),
    at: Date.now(),
  };
  try { localStorage.setItem(CHAT_HANDOFF_KEY, JSON.stringify(handoff)); } catch (_) {}
  window.open(`chat.html?scene=${encodeURIComponent(currentScene)}`, "_blank");
}

// ---- 历史话题：渲染 + 点击直接展示缓存结果（不重新调接口）----
function renderHistory() {
  const list = getHistory();
  if (!list.length) {
    historyEl.classList.add("hidden");
    return;
  }
  historyEl.classList.remove("hidden");
  historyEl.innerHTML =
    `<div class="history-title">历史话题</div>` +
    list
      .map(
        (h, i) => `
        <div class="history-item" data-i="${i}">
          <span class="hi-scene">${escapeHtml(h.scene)}</span>
          <button class="hi-del" data-del="${i}" title="删除">✕</button>
        </div>`
      )
      .join("");

  historyEl.querySelectorAll(".history-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".hi-del")) return;
      showHistory(Number(el.getAttribute("data-i")));
    });
  });
  historyEl.querySelectorAll(".hi-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const list2 = getHistory();
      list2.splice(Number(btn.getAttribute("data-del")), 1);
      setHistory(list2);
      renderHistory();
    });
  });
}

// 点历史话题：直接用缓存的剧本/卡片渲染，不调 /scene。
async function showHistory(index) {
  const h = getHistory()[index];
  if (!h) return;
  setStatus("");
  currentScene = h.scene;
  currentTurns = h.dialogue || [];
  currentCards = h.cards || [];
  sceneInput.value = h.scene;
  const map = await getSaves();
  savedKeys = new Set(Object.keys(map));
  renderDialogue(currentScene, currentTurns);
  renderCards(currentCards);
  stage.classList.remove("hidden");
  stage.scrollIntoView({ behavior: "smooth", block: "start" });
}

renderHistory();
