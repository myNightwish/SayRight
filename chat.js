// chat.js — 独立对练页
// 来源：scene.html 点「进入对练」→ localStorage(chatHandoff) 带来场景+剧本；
//       或 chat.html?scene=场景名 直达 → 用该场景已收藏的句子拼主线。
// 三段式：上=对话窗口（沉浸动效），中=对练结束后「不够地道」复盘（可收藏），下=原始剧本对照。

// 接口地址跟随页面来源（手机经 server 托管访问时自动指向电脑 IP，无需手填）。
const SERVER_ORIGIN = location.protocol.startsWith("http") ? location.origin : "http://127.0.0.1:8770";
const CHAT_API = `${SERVER_ORIGIN}/chat`;
const EXTRACT_API = `${SERVER_ORIGIN}/extract`;
// 访问口令：与 scene.js 一致，?key=xxx 记到 localStorage 后自动带上。
const TUTOR_KEY = (() => {
  try {
    const fromUrl = new URLSearchParams(location.search).get("key");
    if (fromUrl) localStorage.setItem("tutorAccessKey", fromUrl);
    return localStorage.getItem("tutorAccessKey") || "";
  } catch (_) { return ""; }
})();
function apiHeaders() {
  const h = { "Content-Type": "application/json" };
  if (TUTOR_KEY) h["x-tutor-key"] = TUTOR_KEY;
  return h;
}
const STORAGE_KEY = "sceneSaves";
const SCRIPT_KEY = "sceneScripts"; // 场景完整剧本（收藏时由预演页落库）
const HANDOFF_KEY = "chatHandoff";

// ---- 朗读（与 scene.js 一致的高质量美音）----
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
  window.speechSynthesis.addEventListener("voiceschanged", () => { cachedVoice = null; pickVoice(); });
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
  } catch (_) {}
}

// ---- 收藏读写（插件用 chrome.storage，否则 localStorage）----
const hasChromeStorage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
function getSaves() {
  return new Promise((resolve) => {
    if (hasChromeStorage) chrome.storage.local.get(STORAGE_KEY, (res) => resolve(res[STORAGE_KEY] || {}));
    else { try { resolve(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")); } catch (_) { resolve({}); } }
  });
}
function setSaves(map) {
  if (hasChromeStorage) return chrome.storage.local.set({ [STORAGE_KEY]: map });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (_) {}
  return Promise.resolve();
}
const canPersist = hasChromeStorage || typeof localStorage !== "undefined";

// 读场景完整剧本（收藏时由预演页落库到 sceneScripts）。
function getScripts() {
  return new Promise((resolve) => {
    if (hasChromeStorage) chrome.storage.local.get(SCRIPT_KEY, (res) => resolve(res[SCRIPT_KEY] || {}));
    else { try { resolve(JSON.parse(localStorage.getItem(SCRIPT_KEY) || "{}")); } catch (_) { resolve({}); } }
  });
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const chatScene = document.getElementById("chatScene");
const roleTag = document.getElementById("roleTag");
const chatThread = document.getElementById("chatThread");
const chatInput = document.getElementById("chatInput");
const chatSend = document.getElementById("chatSend");
const chatSpotlight = document.getElementById("chatSpotlight");
const chatHint = document.getElementById("chatHint");
const restartBtn = document.getElementById("restartBtn");
const swapBtn = document.getElementById("swapBtn");
const weakPanel = document.getElementById("weakPanel");
const weakList = document.getElementById("weakList");
const scriptPanel = document.getElementById("scriptPanel");
const scriptList = document.getElementById("scriptList");
const toastEl = document.getElementById("toast");

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
}

// ---- 对练状态 ----
let scene = "";
let script = [];          // [{ speaker, text }] 原始剧本
let history = [];          // [{ role:'them'|'me', text }]
let weakLines = [];        // 过程中收集的不够地道句 { said, better, tip }
let busy = false;
let ended = false;
// 角色分配：默认学员演「你」、AI 演剧本里的对方角色。互换后对调。
let swapped = false;
function learnerRoleLabel() {
  // 学员演的角色：未互换=「你」；互换=剧本里第一个非「你」的说话人（对方）。
  if (!swapped) return "你";
  const other = script.find((t) => !/你|我|学员|learner|me/i.test(t.speaker || ""));
  return other ? other.speaker : "对方";
}
function aiRoleLabel() {
  if (!swapped) {
    const other = script.find((t) => !/你|我|学员|learner|me/i.test(t.speaker || ""));
    return other ? other.speaker : "对方";
  }
  return "你";
}
// 某个剧本说话人是不是「当前这一轮学员在演的角色」。
function isLearnerSpeaker(speaker) {
  const me = /你|我|学员|learner|me/i.test(speaker || "");
  return swapped ? !me : me;
}

// 滚动跟随：仅当用户已接近页面底部时才平滑跟到最新；
// 刚进对练看第一句、或用户主动往上翻看时，不强行把页面拽下去。
function scrollChat() {
  const nearBottom =
    window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  if (nearBottom) {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }
}

function appendMsg(role, text, zh) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `
    <div class="avatar">${role === "me" ? "🙋" : "🧑‍💼"}</div>
    <div class="msg-body"><div class="en"></div>${zh ? `<div class="zh">${escapeHtml(zh)}</div>` : ""}</div>`;
  chatThread.appendChild(wrap);
  const enEl = wrap.querySelector(".en");
  if (text != null) enEl.textContent = text;
  scrollChat();
  return { wrap, enEl };
}

function showTyping() {
  const wrap = document.createElement("div");
  wrap.className = "msg them";
  wrap.innerHTML = `<div class="avatar">🧑‍💼</div><div class="msg-body"><div class="typing"><span></span><span></span><span></span></div></div>`;
  chatThread.appendChild(wrap);
  scrollChat();
  return wrap;
}

// 对方台词逐字浮现 + 头像声波。
function typeOut(enEl, text, avatarEl) {
  return new Promise((resolve) => {
    const words = text.split(/(\s+)/);
    let i = 0;
    if (avatarEl) avatarEl.classList.add("speaking");
    speak(text);
    const timer = setInterval(() => {
      enEl.textContent += words[i] || "";
      i++;
      scrollChat();
      if (i >= words.length) {
        clearInterval(timer);
        setTimeout(() => avatarEl && avatarEl.classList.remove("speaking"), 600);
        const btn = document.createElement("button");
        btn.className = "speak";
        btn.textContent = "🔊";
        btn.title = "朗读";
        btn.addEventListener("click", () => speak(text));
        enEl.appendChild(btn);
        resolve();
      }
    }, 55);
  });
}

function setComposer(state) {
  chatSpotlight.classList.toggle("active", state === "active");
  chatSpotlight.classList.toggle("waiting", state === "waiting");
  const off = state !== "active";
  chatInput.disabled = off;
  chatSend.disabled = off;
  if (state === "active") chatInput.focus();
}

function setHint(text) {
  if (text) { chatHint.textContent = `💬 提示：${text}`; chatHint.classList.remove("hidden"); }
  else chatHint.classList.add("hidden");
}

// 即时反馈：地道绿勾一闪；不地道气泡下方展开，并记进 weakLines 供赛后复盘。
function renderFeedback(fb) {
  if (!fb) return;
  if (fb.ok) {
    if (history.some((h) => h.role === "me")) {
      const flash = document.createElement("div");
      flash.className = "ok-flash";
      flash.textContent = "✓ 地道";
      chatThread.appendChild(flash);
      setTimeout(() => flash.remove(), 1900);
    }
    return;
  }
  if (!fb.better && !fb.tip) return;
  // 记录这条不够地道（对应你刚说的那句）。
  const lastMe = [...history].reverse().find((h) => h.role === "me");
  weakLines.push({ said: lastMe ? lastMe.text : "", better: fb.better, tip: fb.tip });
  const el = document.createElement("div");
  el.className = "feedback";
  const better = fb.better ? `<div class="fb-better">💡 ${escapeHtml(fb.better)}<button class="speak" title="朗读">🔊</button></div>` : "";
  const tip = fb.tip ? `<div class="fb-tip">${escapeHtml(fb.tip)}</div>` : "";
  el.innerHTML = better + tip;
  chatThread.appendChild(el);
  const sb = el.querySelector(".speak");
  if (sb) sb.addEventListener("click", () => speak(fb.better));
  scrollChat();
}

async function advance() {
  if (busy || ended) return;
  busy = true;
  setComposer("waiting");
  setHint("");
  const typing = showTyping();
  try {
    const resp = await fetch(CHAT_API, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ scene, script, history, learnerRole: learnerRoleLabel(), aiRole: aiRoleLabel() }),
    });
    const data = await resp.json();
    typing.remove();
    if (!resp.ok) { toast(data.error || "对练出错了，请重试"); setComposer("active"); return; }
    renderFeedback(data.feedback);
    const { enEl, wrap } = appendMsg("them", "", data.reply_zh);
    await typeOut(enEl, data.reply, wrap.querySelector(".avatar"));
    history.push({ role: "them", text: data.reply });
    if (data.done) { ended = true; finish(); }
    else { setComposer("active"); setHint(data.hint || ""); }
  } catch (_) {
    typing.remove();
    toast("连不上本地服务，请确认 tutor-server.mjs 已启动");
    setComposer("active");
  } finally {
    busy = false;
  }
}

async function send() {
  const text = chatInput.value.trim();
  if (!text || busy || ended) return;
  appendMsg("me", text, "");
  history.push({ role: "me", text });
  chatInput.value = "";
  await advance();
}

// 对练结束：渲染中段「不够地道」复盘（可收藏），展开下段原始剧本。
function finish() {
  setComposer("waiting");
  setHint("");
  renderWeak();
  weakPanel.classList.remove("hidden");
}

function renderWeak() {
  if (!weakLines.length) {
    weakList.innerHTML = `<div class="empty">这场你表现得很地道，没有需要改的地方 👏</div>`;
    return;
  }
  weakList.innerHTML = weakLines
    .map((w, i) => `
      <div class="weak-card">
        <button class="weak-save" data-i="${i}" title="收藏地道说法">☆</button>
        ${w.said ? `<div class="weak-said"><span class="tag">你说的</span>${escapeHtml(w.said)}</div>` : ""}
        <div class="weak-better">💡 ${escapeHtml(w.better)}<button class="speak" title="朗读">🔊</button></div>
        ${w.tip ? `<div class="weak-tip">${escapeHtml(w.tip)}</div>` : ""}
      </div>`)
    .join("");
  weakList.querySelectorAll(".speak").forEach((btn, idx) => {
    btn.addEventListener("click", () => speak(weakLines[idx].better));
  });
  weakList.querySelectorAll(".weak-save").forEach((btn) => {
    btn.addEventListener("click", () => saveWeak(Number(btn.getAttribute("data-i")), btn));
  });
}

// 收藏「地道说法」：调 /extract 把 better 抽成骨架卡，存进当前场景空间。
async function saveWeak(index, btn) {
  const w = weakLines[index];
  if (!w) return;
  const lineKey = `${scene}||${w.better}`;
  const map = await getSaves();
  if (map[lineKey]) {
    delete map[lineKey];
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
      headers: apiHeaders(),
      body: JSON.stringify({ scene, speaker: "你", text: w.better }),
    });
    const card = await resp.json();
    if (!resp.ok) { toast(card.error || "抽卡失败"); btn.classList.remove("saving"); btn.textContent = "☆"; return; }
    const fresh = await getSaves();
    fresh[lineKey] = {
      scene, type: card.type, source: "me",
      intent: card.intent, better: card.better, construct: card.construct, note: card.note,
      savedAt: Date.now(),
    };
    await setSaves(fresh);
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

// 下段：原始剧本对照（折叠在底部，气泡式左右分边）。
function renderScript() {
  if (!script.length) { scriptPanel.classList.add("hidden"); return; }
  scriptPanel.classList.remove("hidden");
  const isLearner = (sp) => /你|我|学员|learner|me/i.test(sp || "");
  scriptList.innerHTML = script
    .map((t) => {
      const me = isLearner(t.speaker);
      return `
      <div class="script-turn ${me ? "me" : "them"}">
        <div class="s-avatar">${me ? "🙋" : "🧑‍💼"}</div>
        <div class="s-bubble">
          <span class="stext">${escapeHtml(t.text)}</span>
          <button class="speak" data-text="${escapeHtml(t.text)}" title="朗读">🔊</button>
        </div>
      </div>`;
    })
    .join("");
  scriptList.querySelectorAll(".speak").forEach((btn) => {
    btn.addEventListener("click", () => speak(btn.getAttribute("data-text")));
  });
}

function resetChat() {
  history = [];
  weakLines = [];
  ended = false;
  chatThread.innerHTML = "";
  weakPanel.classList.add("hidden");
  chatInput.value = "";
  setHint("");
  // 顶部显示当前你演的角色（互换后会变）。
  if (roleTag) roleTag.textContent = `你演：${learnerRoleLabel()}`;
  // 不论谁先说，都让对方先发一条：
  // - 剧本对方先说 → 对方说剧本第一句
  // - 剧本「你」先说 → 对方先说一句招呼把话头交给你（不剧透剧本内容），再轮到你
  // 这一逻辑由后端 prompt 按剧本第一句的 speaker + 角色分配决定，前端统一走 advance()。
  advance();
}

// 互换角色：你改演原本的对方角色，AI 反过来演原本的你。剧本主线不变，重开一局。
function swapRoles() {
  swapped = !swapped;
  toast(swapped ? "已互换：现在你演对方" : "已换回：你演自己");
  resetChat();
}

// ---- 启动：拿场景 + 剧本 ----
// 剧本来源优先级：
//   1) 预演页交接的 handoff（刚从预演点进来，最新最准）
// 剧本来源优先级（修复：避免残留 handoff 劫持，优先用落库的完整剧本）：
//   1) sceneScripts 里收藏时落库的完整有序剧本（最可靠，从任何入口都对）
//   2) 新鲜的 handoff（刚从预演点「对话演练」进来，30 秒内写入，用完即焚）
//   3) 兜底：该场景已收藏的散句按时间拼（旧数据，可能乱序）
async function boot() {
  const params = new URLSearchParams(location.search);
  const urlScene = params.get("scene");

  // 读并清掉 handoff（用完即焚，防止残留影响之后的对练）。
  let handoff = null;
  try {
    handoff = JSON.parse(localStorage.getItem(HANDOFF_KEY) || "null");
    localStorage.removeItem(HANDOFF_KEY);
  } catch (_) {}
  // 只认 60 秒内、且场景匹配的新鲜 handoff。
  const freshHandoff =
    handoff && handoff.at && Date.now() - handoff.at < 60000 &&
    (!urlScene || handoff.scene === urlScene) ? handoff : null;

  scene = urlScene || (freshHandoff && freshHandoff.scene) || "";

  // ① 优先用落库的完整剧本。
  let resolved = null;
  if (scene) {
    const scripts = await getScripts();
    const saved = scripts[scene];
    if (saved && Array.isArray(saved.dialogue) && saved.dialogue.length) {
      resolved = saved.dialogue.map((t) => ({ speaker: t.speaker, text: t.text }));
    }
  }
  // ② 没落库剧本，但有新鲜 handoff（刚预演完、可能还没收藏）→ 用 handoff 的完整剧本。
  if (!resolved && freshHandoff && Array.isArray(freshHandoff.script) && freshHandoff.script.length) {
    resolved = freshHandoff.script;
  }
  // ③ 兜底：散句拼接（旧数据）。
  if (!resolved && scene) {
    const map = await getSaves();
    resolved = Object.values(map)
      .filter((it) => it.scene === scene && it.type !== "word")
      .sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))
      .map((it) => ({ speaker: it.source === "me" ? "你" : "对方", text: it.better }));
  }
  script = resolved || [];

  if (!scene) {
    chatScene.textContent = "没有场景";
    toast("请从预演页或收藏页进入对练");
    return;
  }
  chatScene.textContent = scene;
  renderScript();
  resetChat();
}

chatSend.addEventListener("click", send);
chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
restartBtn.addEventListener("click", resetChat);
swapBtn.addEventListener("click", swapRoles);

boot();
