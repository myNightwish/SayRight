const sourceText = document.querySelector("#sourceText");
const directionBadge = document.querySelector("#directionBadge");
const sceneSelect = document.querySelector("#sceneSelect");
const toneSelect = document.querySelector("#toneSelect");
const strictnessSelect = document.querySelector("#strictnessSelect");
const translateButton = document.querySelector("#translateButton");
const tutorButton = document.querySelector("#tutorButton");
const copyButton = document.querySelector("#copyButton");
const saveButton = document.querySelector("#saveButton");
const resultText = document.querySelector("#resultText");
const memoInput = document.querySelector("#memoInput");
const memoRow = document.querySelector("#memoRow");
const starsPicker = document.querySelector("#starsPicker");
const polishAssistantImage = document.querySelector("#polishAssistantImage");
const polishAssistantTitle = document.querySelector("#polishAssistantTitle");
const polishAssistantStatus = document.querySelector("#polishAssistantStatus");

const POLISH_ASSISTANT_STATES = {
  idle: {
    src: "images/mascot-study-v2.png",
    title: "把想说的直接写下来",
    status: "中英文都可以，我会结合场景处理。",
    alt: "Coco 正在陪你练习表达",
  },
  thinking: {
    src: "images/mascot-thinking-v1.gif",
    title: "正在理解你的语境",
    status: "会同时检查自然度、语气和使用场景。",
    alt: "Coco 正在思考更自然的表达",
  },
  success: {
    src: "images/mascot-success-v1.gif",
    title: "表达已经整理好了",
    status: "重点看更自然的版本，再听一遍发音。",
    alt: "Coco 正在庆祝表达完成",
  },
  error: {
    src: "images/mascot-comfort-v1.gif",
    title: "这次没有处理成功",
    status: "内容还保留着，稍后可以直接重试。",
    alt: "Coco 正在提醒你稍后重试",
  },
};

function setPolishAssistant(stateName) {
  if (!polishAssistantImage) return;
  const state = POLISH_ASSISTANT_STATES[stateName] || POLISH_ASSISTANT_STATES.idle;
  polishAssistantImage.src = state.src;
  polishAssistantImage.alt = state.alt;
  polishAssistantTitle.textContent = state.title;
  polishAssistantStatus.textContent = state.status;
}

const PLACEHOLDER_RESULT = "翻译或润色结果......";
const TRANSLATE_LABEL = "翻译";
const COPY_LABEL = "⧉ 复制";
// 润色（tutor）走桥接服务。H5 网页版跟随 location.origin；
// 插件（chrome-extension:// 协议）没有自己的后端，打到 config.js 的线上域名。
const SERVER_ORIGIN =
  typeof location !== "undefined" && location.protocol.startsWith("http")
    ? location.origin
    : (typeof window !== "undefined" && window.NUANCE_REMOTE_ORIGIN) || "http://127.0.0.1:8770";
const TUTOR_ENDPOINT = `${SERVER_ORIGIN}/polish`;
// 访问口令：公网部署后带上 x-tutor-key。?key=xxx 首次记到 localStorage。本机自用留空。
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
// 润色收藏：tutor 自己的收藏，存在 chrome.storage.local 的 corrections 键下，
// 与划词收藏插件（favorites 键）互不影响。
const STORAGE_KEY = "corrections";

let currentResult = ""; // 当前可复制的纯文本（翻译译文 或 润色后的地道表达）
let currentPolish = null; // 最近一次润色结果 { input, natural, better, note }，用于收藏

function detectDirection(text) {
  return /[㐀-鿿]/.test(text) ? "zh-to-en" : "en-to-zh";
}

function getDirectionLabel(direction) {
  return direction === "zh-to-en" ? "中文 → 英文" : "英文 → 中文";
}

function resetTranslateButton() {
  translateButton.textContent = TRANSLATE_LABEL;
  translateButton.setAttribute("aria-label", TRANSLATE_LABEL);
}

function setCopyButtonState(state = "idle") {
  // 复制按钮：成功短暂变绿 ✓ 已复制，否则显示「⧉ 复制」。
  copyButton.classList.toggle("copied", state === "success");
  copyButton.textContent = state === "success" ? "✓ 已复制" : COPY_LABEL;
  copyButton.title = state === "error" ? "复制失败" : "复制";
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

// 发音：朗读地道说法。优先 macOS 自带高质量美音（与收藏页/练习页一致）。
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

// 渲染可复用表达块（chunks）。兼容老数据：construct 字符串当单个 skeleton 块。
// 每块显示：块文本（槽位高亮）+ 类型标 + 中文用途；升级点(isUpgrade)特别高亮。
// 收藏当下可编辑：文本就地改（contenteditable），可删、可点类型标切换、可自己加一条。
// 编辑直接作用于 currentPolish.chunks，收藏时 toggleSave 自然带上校订后的版本。
const CHUNK_TYPES = ["fixed", "skeleton", "semi"];
const CHUNK_TYPE_LABEL = { fixed: "固定表达", skeleton: "句型骨架", semi: "半固定" };

// 把 currentPolish.chunks 归一成一个真数组（老数据的 construct 合成单块），
// 之后所有编辑都落在这个数组上，收藏即持久化。
function ensureChunksArray() {
  if (!currentPolish) return [];
  if (!Array.isArray(currentPolish.chunks)) currentPolish.chunks = [];
  if (!currentPolish.chunks.length && currentPolish.construct) {
    currentPolish.chunks = [{ text: currentPolish.construct, type: "skeleton", label: "", isUpgrade: false }];
  }
  return currentPolish.chunks;
}

function renderChunks() {
  const chunks = ensureChunksArray();
  const rows = chunks
    .map((c, i) => {
      const t = CHUNK_TYPES.includes(c.type) ? c.type : "skeleton";
      const up = c.isUpgrade ? `<span class="chunk-up">✨ 你可能想不到</span>` : "";
      const label = c.label ? `<span class="chunk-label">${escapeHtml(c.label)}</span>` : "";
      return `
        <div class="chunk-row ${c.isUpgrade ? "upgrade" : ""}" data-chunk="${i}">
          <div class="chunk-text" contenteditable="true" data-chunk-edit="${i}"
            title="点这里改文字">${highlightSlots(c.text)}</div>
          <button class="chunk-del" data-chunk-del="${i}" type="button" title="删掉这条">✕</button>
          <div class="chunk-meta">
            <button class="chunk-type ${t}" data-chunk-type="${i}" type="button" title="点一下换类型">${CHUNK_TYPE_LABEL[t]}</button>
            ${label}${up}
          </div>
        </div>`;
    })
    .join("");
  return `
    <div class="chunks" id="chunksBox">
      <div class="chunks-title">可复用表达 · 可改可删</div>
      ${rows}
      <button class="chunk-add" id="chunkAdd" type="button">＋ 自己加一条</button>
    </div>`;
}

// 绑定 chunks 的就地编辑：文本失焦存、删除、类型切换、新增。改完只重渲染 chunks 区。
function bindChunks() {
  const box = resultText.querySelector("#chunksBox");
  if (!box) return;
  const chunks = ensureChunksArray();

  // 文本就地编辑：失焦时把纯文本（去掉槽位高亮 span）写回。
  box.querySelectorAll("[data-chunk-edit]").forEach((el) => {
    el.addEventListener("blur", () => {
      const i = Number(el.getAttribute("data-chunk-edit"));
      if (chunks[i]) chunks[i].text = el.textContent.trim();
    });
    // 回车＝结束编辑（不换行）
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); el.blur(); }
    });
  });

  // 删除某条
  box.querySelectorAll("[data-chunk-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.getAttribute("data-chunk-del"));
      chunks.splice(i, 1);
      rerenderChunks();
    });
  });

  // 点类型标：fixed → skeleton → semi 循环
  box.querySelectorAll("[data-chunk-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.getAttribute("data-chunk-type"));
      if (!chunks[i]) return;
      const cur = CHUNK_TYPES.indexOf(chunks[i].type);
      chunks[i].type = CHUNK_TYPES[(cur + 1) % CHUNK_TYPES.length];
      rerenderChunks();
    });
  });

  // 自己加一条：默认固定表达，加完聚焦到新行让用户直接打字。
  const addBtn = box.querySelector("#chunkAdd");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      chunks.push({ text: "", type: "fixed", label: "", isUpgrade: false });
      rerenderChunks();
      const last = resultText.querySelector(`[data-chunk-edit="${chunks.length - 1}"]`);
      if (last) last.focus();
    });
  }
}

// 只重画 chunks 区（编辑/删除/加条后），不动整块结果，避免闪烁与丢焦。
function rerenderChunks() {
  const box = resultText.querySelector("#chunksBox");
  if (!box) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = renderChunks();
  box.replaceWith(tmp.firstElementChild);
  bindChunks();
}

// 统一输出区写入入口：
//  - copyText 是「复制」按钮真正复制的纯文本；传空则禁用复制
//  - html 为可选富文本（润色结果用），不传则按纯文本展示
function setResult(copyText, html) {
  currentResult = copyText || "";
  resultText.classList.remove("loading"); // 写真实结果时清掉加载态
  if (html != null) {
    resultText.innerHTML = html;
    resultText.classList.add("has-result");
    resultText.classList.add("rich"); // 富文本：关掉 pre-wrap，避免模板缩进/换行被渲染成空行
  } else {
    resultText.textContent = copyText || PLACEHOLDER_RESULT;
    resultText.classList.toggle("has-result", Boolean(copyText));
    resultText.classList.remove("rich");
  }
  copyButton.disabled = !currentResult;
}

// 加载态：置灰 + 呼吸脉冲 + 三个跳动的点，明确区别于「已出结果」。
// 注意不走 setResult，避免被 has-result 点亮成正式结果的深色实线样式。
function setLoading(msg) {
  currentResult = "";
  resultText.innerHTML =
    `<span class="loading-line">${escapeHtml(msg)}<span class="loading-dots"><i></i><i></i><i></i></span></span>`;
  resultText.classList.remove("has-result", "rich");
  resultText.classList.add("loading");
  copyButton.disabled = true;
}

function updateInputMeta() {
  const text = sourceText.value.trim();
  directionBadge.textContent = text ? getDirectionLabel(detectDirection(text)) : "自动判断方向";
}
// __APPEND_TRANSLATE__

async function translateViaGoogle(text, from, to) {
  // 谷歌免费翻译端点（gtx）：无需 key，质量好、速度快。
  // 返回结构是嵌套数组，data[0] 是分段译文，每段的第 0 项是译文文本。
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx" +
    `&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`google ${response.status}`);
  const data = await response.json();
  const segments = (data && data[0]) || [];
  const result = segments.map((seg) => (seg && seg[0]) || "").join("");
  if (!result) throw new Error("google 空结果");
  return result;
}

async function translateViaMyMemory(text, from, to) {
  // 兜底：MyMemory 免费接口，谷歌不可用时使用。
  const url =
    "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text) +
    `&langpair=${from}|${to}`;
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  const result = data?.responseData?.translatedText;
  if (!response.ok || !result) throw new Error("mymemory 失败");
  return result;
}

async function translateText(text, direction) {
  // 98% 场景是英译中；direction 仍保留以兼容偶尔的中译英。
  const [from, to] = direction === "zh-to-en" ? ["zh-CN", "en"] : ["en", "zh-CN"];
  try {
    return await translateViaGoogle(text, from, to);
  } catch (error) {
    console.warn("谷歌翻译失败，改用 MyMemory：", error);
    return await translateViaMyMemory(text, from, to);
  }
}
// __APPEND_POLISH__

// 润色：请求本地桥接服务，由它用 Claude Agent SDK 跑严格受限的输出。
// 服务返回 { natural, intent, better, note, impression, scores{grammar,idiomatic,fitness}, tones[] }。
async function polishExpression(text, scene, tone, strictness) {
  let response;
  try {
    response = await fetch(TUTOR_ENDPOINT, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ text, scene, tone, strictness }),
    });
  } catch (_) {
    // 连不上本地服务（没启动）
    throw new Error("NO_SERVER");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.error || `润色服务异常 (${response.status})`);
  }
  return data;
}

// 一个评分数字环：SVG 圆环，实心程度 = 分数，环心放数字。
function scoreRing(label, val) {
  if (val == null) return "";
  let cls = "high";
  if (val < 60) cls = "low";
  else if (val < 80) cls = "mid";
  const R = 13;
  const C = 2 * Math.PI * R; // 周长
  const dash = (val / 100) * C;
  return `
    <div class="ring-item">
      <svg class="ring ${cls}" viewBox="0 0 32 32" width="32" height="32">
        <circle class="ring-bg" cx="16" cy="16" r="${R}" />
        <circle class="ring-fg" cx="16" cy="16" r="${R}"
          stroke-dasharray="${dash.toFixed(1)} ${(C - dash).toFixed(1)}"
          transform="rotate(-90 16 16)" />
        <text x="16" y="16" class="ring-num" dominant-baseline="central" text-anchor="middle">${val}</text>
      </svg>
      <span class="ring-label">${label}</span>
    </div>`;
}

// 把润色结果渲染到输出区。复制按钮复制的是「地道表达」那句。
// 语气版本点一下即可把该版本设为当前复制内容。
function renderPolish(result) {
  const better = escapeHtml(result.better || "");
  const sc = result.scores || {};
  const scoresHtml = (sc.grammar != null || sc.idiomatic != null || sc.fitness != null)
    ? `<div class="scores">${scoreRing("语法", sc.grammar)}${scoreRing("地道", sc.idiomatic)}${scoreRing("场景", sc.fitness)}</div>`
    : "";
  // 对方印象：natural 为真 → 绿色 plain（地道）；为假 → 黄色 plain（警告），
  // 并在句尾追加"更好的表达："引出下方的正确说法。
  const impression = result.impression
    ? (result.natural
        ? `<div class="impression good">${escapeHtml(result.impression)}</div>`
        : `<div class="impression warn">${escapeHtml(result.impression)}，更好的表达：</div>`)
    : "";
  // const intent = result.intent
  //   ? `<div class="intent-line">👀 ${escapeHtml(result.intent)}</div>`
  //   : "";
   const intent = '';
  const note = result.note
    ? `<div class="polish-note"><span class="note-label">为什么这么改</span>${escapeHtml(result.note)}</div>`
    : "";
  // 可复用表达块（chunks）：固定/骨架/半固定分类，升级点高亮。给迁移练习铺路。
  // 收藏当下可就地编辑（改/删/加/切类型），编辑落在 currentPolish.chunks 上。
  const chunksHtml = renderChunks();
  // 当前场景+语气标注：用户关心的是"在这个场景、这个语气下"我的表达合不合适。
  // 场景为空时显示「通用」，语气为空时显示「自然」，始终给出上下文。
  const sceneLabel = (currentPolish && currentPolish.scene) || "通用";
  const toneLabel = (currentPolish && currentPolish.tone) || "自然";
  const ctx = `<span class="ctx-badge">${escapeHtml(sceneLabel)} · ${escapeHtml(toneLabel)}语气</span>`;
  // const status = result.natural
  //   ? `<div class="polish-status good">✅  ${ctx}</div>`
  //   : `<div class="polish-status warn">💡 更贴合该场景与语气的说法 ${ctx}</div>`;

  // 语气版本（可点切换复制内容）—— 给出其它语气做对比
  let tonesHtml = "";
  if (Array.isArray(result.tones) && result.tones.length) {
    const chips = result.tones.map((t, i) =>
      `<button class="tone-chip" data-tone="${i}" type="button">${escapeHtml(t.label)}</button>`
    ).join("");
    tonesHtml = `
      <div class="tones">
        <div class="tones-label">换个语气对比</div>
        <div class="tones-row">${chips}</div>
        <div class="tone-text" id="toneText"></div>
      </div>`;
  }

  // 逻辑顺序：先「对方印象」（这句给人的感觉）→ 再「该场景语气下更好的说法」标题 → 紧接正确表达。
  // 地道说法带一个 🔊 朗读按钮，随时能听发音。
  const html = `${impression}<div class="polish-better">${better}<button class="speak polish-speak" id="betterSpeak" title="朗读">🔊</button></div>${chunksHtml}${scoresHtml}${note}${tonesHtml}`;
  setResult(result.better || "", html);

  // 朗读地道说法
  const betterSpeak = resultText.querySelector("#betterSpeak");
  if (betterSpeak) betterSpeak.addEventListener("click", () => speak(result.better || ""));

  // 绑定 chunks 就地编辑（改/删/加/切类型）——编辑作用于 currentPolish.chunks
  bindChunks();

  // 绑定语气切换
  if (Array.isArray(result.tones) && result.tones.length) {
    const toneTextEl = resultText.querySelector("#toneText");
    resultText.querySelectorAll(".tone-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = result.tones[Number(btn.dataset.tone)];
        if (!t) return;
        resultText.querySelectorAll(".tone-chip").forEach((b) => b.classList.toggle("active", b === btn));
        if (toneTextEl) toneTextEl.textContent = t.text;
        // 选中某语气版本后，复制按钮复制该版本
        currentResult = t.text;
        copyButton.disabled = false;
        setCopyButtonState("idle");
      });
    });
  }
}

// --- 润色收藏（chrome.storage.local 的 corrections 键）---
// 以原句 input（小写）为去重 key，存 { input, better, note, natural, savedAt }。
function correctionKey(input) {
  return (input || "").trim().toLowerCase();
}

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

// 星级：0=只进接收库（普通收藏）；1–5=晋升进产出核心，星越多＝越高频/越优先，
// 练习与对练据此排序。兼容早期布尔 starred（视作 3 星）。
function starLevel(it) {
  if (!it) return 0;
  if (typeof it.stars === "number") return it.stars;
  return it.starred ? 3 : 0;
}

// 把当前润色写进收藏 map（若尚未收藏则按草稿新建），返回其 key。
// 收藏按钮与星级选择器共用它，避免两处各写一份收藏结构。
function ensureSaved(map) {
  const key = correctionKey(currentPolish.input);
  if (!key) return "";
  if (!map[key]) {
    // 记忆提示：用户选填的「唤醒这句话的情境」优先；没填则回退到模型生成的 situation。
    const userMemo = (memoInput && memoInput.value.trim()) || "";
    map[key] = {
      input: currentPolish.input,
      scene: currentPolish.scene || "通用",
      tone: currentPolish.tone || "自然",
      intent: currentPolish.intent || "",
      situation: userMemo || currentPolish.situation || "",
      situations: Array.isArray(currentPolish.situations) ? currentPolish.situations : [],
      better: currentPolish.better || "",
      chunks: Array.isArray(currentPolish.chunks) ? currentPolish.chunks : [],
      note: currentPolish.note || "",
      impression: currentPolish.impression || "",
      scores: currentPolish.scores || null,
      tones: Array.isArray(currentPolish.tones) ? currentPolish.tones : [],
      natural: Boolean(currentPolish.natural),
      stars: 0,          // 默认进接收库；点星级才晋升进产出核心
      createdAt: Date.now(), // 收藏那天，固定不变——供收藏页日期分组；savedAt 只服务同步
      savedAt: Date.now(),
    };
  }
  return key;
}

// 画出 5 颗星，点亮到 level。level=0 全空（未进核心）。
function renderStarsPicker(level) {
  if (!starsPicker) return;
  let html = "";
  for (let i = 1; i <= 5; i++) {
    html += `<button class="star ${i <= level ? "on" : ""}" data-star="${i}" type="button"
      title="${i} 星${i <= level ? "（点它取消到此级）" : ""}">${i <= level ? "★" : "☆"}</button>`;
  }
  const tip = level ? `产出核心 · ${level} 星` : "点星标记为高频核心";
  starsPicker.innerHTML = `${html}<span class="stars-tip">${tip}</span>`;
}

// 设星级：n=点的那颗星。再点当前最高星＝降到 n-1（可一路清零，但仍保留收藏）。
// 设星隐含「收藏」——没收藏会先建，契合「polish 时就能打星」。
async function setStars(n) {
  if (!currentPolish) return;
  const map = await getCorrections();
  const key = ensureSaved(map);
  if (!key) return;
  const cur = starLevel(map[key]);
  map[key].stars = (cur === n) ? n - 1 : n;   // 点已亮的最高星＝取消这一级
  map[key].savedAt = Date.now();
  await setCorrections(map);
  if (window.NuanceSync) window.NuanceSync.syncNow();
  await refreshSaveButton();
}

// 根据当前润色结果是否已收藏，刷新收藏按钮 + 星级选择器外观。
async function refreshSaveButton() {
  if (!currentPolish) {
    saveButton.hidden = true;
    if (memoRow) memoRow.hidden = true;
    if (starsPicker) starsPicker.closest(".stars-row")?.setAttribute("hidden", "");
    return;
  }
  saveButton.hidden = false;
  if (memoRow) memoRow.hidden = false;
  const starsRow = starsPicker && starsPicker.closest(".stars-row");
  if (starsRow) starsRow.removeAttribute("hidden");
  const map = await getCorrections();
  const saved = map[correctionKey(currentPolish.input)];
  // 已收藏：把存过的记忆提示回填到输入框，方便查看/修改；未收藏时清空，用占位提示引导新填。
  if (memoInput) memoInput.value = saved ? (saved.situation || "") : "";
  renderStarsPicker(saved ? starLevel(saved) : 0);
  saveButton.classList.toggle("active", Boolean(saved));
  saveButton.textContent = saved ? "★ 已收藏" : "☆ 收藏";
  saveButton.title = saved ? "取消收藏" : "收藏这条润色";
}

async function toggleSave() {
  if (!currentPolish) return;
  const key = correctionKey(currentPolish.input);
  if (!key) return;
  const map = await getCorrections();
  if (map[key]) {
    delete map[key];
    if (memoInput) memoInput.value = "";
    await setCorrections(map);
    // 取消收藏要记墓碑并立即上行，否则同步会把服务端还留着的这条又并回来（「删了又复活」）。
    if (window.NuanceSync) window.NuanceSync.recordDelete(key);
  } else {
    ensureSaved(map);
    await setCorrections(map);
    // 新收藏立即上行，别攒着——慢同步途中若被别的写回覆盖就会丢（已在 sync 侧加防丢，这里再主动推一把）。
    if (window.NuanceSync) window.NuanceSync.syncNow();
  }
  await refreshSaveButton();
}

// 星级选择器点击：设星（隐含收藏）。
if (starsPicker) {
  starsPicker.addEventListener("click", (e) => {
    const btn = e.target.closest(".star");
    if (!btn) return;
    setStars(Number(btn.getAttribute("data-star")));
  });
}
// __APPEND_HANDLERS__

function setBusy(busy) {
  translateButton.disabled = busy;
  tutorButton.disabled = busy;
}

async function handleTranslate() {
  const text = sourceText.value.trim();
  if (!text) {
    setResult("");
    setCopyButtonState("error");
    sourceText.focus();
    return;
  }

  const direction = detectDirection(text);
  setBusy(true);
  copyButton.disabled = true;
  setCopyButtonState("idle");
  currentPolish = null;        // 翻译结果不可收藏
  refreshSaveButton();
  setLoading("翻译中…");
  setPolishAssistant("thinking");

  try {
    const translatedText = await translateText(text, direction);
    setResult(translatedText);
    setPolishAssistant("success");
  } catch (error) {
    console.error(error);
    setResult("");
    setCopyButtonState("error");
    setPolishAssistant("error");
  } finally {
    setBusy(false);
  }
}

async function handleTutor() {
  const text = sourceText.value.trim();
  if (!text) {
    setResult("");
    setCopyButtonState("error");
    sourceText.focus();
    return;
  }

  setBusy(true);
  copyButton.disabled = true;
  setCopyButtonState("idle");
  currentPolish = null;
  refreshSaveButton();
  setLoading("正在分析地道表达…");
  setPolishAssistant("thinking");

  try {
    const result = await polishExpression(text, sceneSelect.value, toneSelect.value, strictnessSelect.value);
    // 记录本次润色（含场景/语气），供收藏与渲染用
    currentPolish = { input: text, scene: sceneSelect.value, tone: toneSelect.value, ...result };
    renderPolish(result);
    refreshSaveButton();
    setPolishAssistant("success");
  } catch (error) {
    console.error(error);
    const msg =
      error.message === "NO_SERVER"
        ? "润色服务未启动，请先运行 tutor-server（见 README）。"
        : `润色失败：${error.message}`;
    setResult("", `<div class="polish-hint">${escapeHtml(msg)}</div>`);
    setCopyButtonState("error");
    setPolishAssistant("error");
  } finally {
    setBusy(false);
  }
}

async function handleCopy() {
  if (!currentResult) {
    setCopyButtonState("error");
    return;
  }
  try {
    await navigator.clipboard.writeText(currentResult);
    setCopyButtonState("success");
    setTimeout(() => setCopyButtonState("idle"), 1200);
  } catch (error) {
    console.error(error);
    setCopyButtonState("error");
  }
}

sourceText.addEventListener("input", () => {
  updateInputMeta();
  setCopyButtonState("idle");
  setPolishAssistant("idle");
});
sourceText.addEventListener("focus", () => sourceText.select());
sourceText.addEventListener("click", () => sourceText.select());

translateButton.addEventListener("click", handleTranslate);
tutorButton.addEventListener("click", handleTutor);
copyButton.addEventListener("click", handleCopy);
saveButton.addEventListener("click", toggleSave);

sourceText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    // 主行为是「地道检测/换说法」：回车直接润色；Shift+Enter 换行。
    // 翻译是次要功能，留给点按钮。
    handleTutor();
  }
});

updateInputMeta();
setResult("");
resetTranslateButton();
setCopyButtonState();
// 严格度：恢复上次选择（默认严格挑剔），改动后记住。
try {
  const savedStrictness = localStorage.getItem("tutorStrictness");
  if (savedStrictness === "easy" || savedStrictness === "strict") {
    strictnessSelect.value = savedStrictness;
  }
} catch (_) {}
strictnessSelect.addEventListener("change", () => {
  try { localStorage.setItem("tutorStrictness", strictnessSelect.value); } catch (_) {}
});

// --- H5 移动端表达设置：场景 / 语气 / 严格度放到底部 Sheet ---
(function initExpressionSettings() {
  const openBtn = document.querySelector("#openExpressionSettings");
  const panel = document.querySelector("#expressionSettings");
  const sheet = panel?.querySelector(".expression-settings-sheet");
  const closeBtn = document.querySelector("#closeExpressionSettings");
  const summary = document.querySelector("#expressionSettingsSummary");
  if (!openBtn || !panel || !sheet || !closeBtn || !summary) return;

  const mobileMedia = window.matchMedia?.("(max-width: 768px)");
  const isMobile = () => Boolean(mobileMedia?.matches);
  const selectedText = (select, fallback) => select.selectedOptions?.[0]?.textContent?.trim() || fallback;

  function updateSummary() {
    const scene = selectedText(sceneSelect, "通用");
    const tone = selectedText(toneSelect, "自然");
    const strictness = strictnessSelect.value === "easy" ? "鼓励" : "严格";
    summary.textContent = `${scene} · ${tone} · ${strictness}`;
  }

  function open() {
    if (!isMobile()) return;
    panel.classList.add("is-open");
    panel.setAttribute("aria-hidden", "false");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    openBtn.setAttribute("aria-expanded", "true");
    setTimeout(() => sceneSelect.focus(), 0);
  }

  function close({ restoreFocus = true } = {}) {
    panel.classList.remove("is-open");
    panel.setAttribute("aria-hidden", "true");
    sheet.removeAttribute("role");
    sheet.removeAttribute("aria-modal");
    openBtn.setAttribute("aria-expanded", "false");
    if (restoreFocus) openBtn.focus();
  }

  function syncViewportMode() {
    if (isMobile()) {
      if (!panel.classList.contains("is-open")) panel.setAttribute("aria-hidden", "true");
      return;
    }
    panel.classList.remove("is-open");
    panel.removeAttribute("aria-hidden");
    sheet.removeAttribute("role");
    sheet.removeAttribute("aria-modal");
    openBtn.setAttribute("aria-expanded", "false");
  }

  openBtn.setAttribute("aria-expanded", "false");
  syncViewportMode();
  mobileMedia?.addEventListener?.("change", syncViewportMode);
  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", () => close());
  panel.addEventListener("pointerdown", (event) => {
    if (event.target === panel) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.classList.contains("is-open")) close();
  });
  [sceneSelect, toneSelect, strictnessSelect].forEach((select) => {
    select.addEventListener("change", updateSummary);
  });
  updateSummary();
})();

// --- 设置：访问口令输入 ---
// 口令存 localStorage（auth.js 的 fetch 拦截器在请求时实时读它，改完立即生效，无需重载弹窗）。
// 同时镜像到 chrome.storage.local，插件重装/清缓存后仍在，启动时回填。
(function initSettings() {
  const settingsBtn = document.querySelector("#openSettings");
  const settingsPanel = document.querySelector("#settingsPanel");
  const keyInput = document.querySelector("#accessKeyInput");
  const saveKeyBtn = document.querySelector("#saveKeyButton");
  const statusEl = document.querySelector("#settingsStatus");
  if (!settingsBtn || !settingsPanel || !keyInput || !saveKeyBtn) return;

  const LS_KEY = "tutorAccessKey";
  const readLocal = () => { try { return localStorage.getItem(LS_KEY) || ""; } catch (_) { return ""; } };
  function writeKey(v) {
    try { localStorage.setItem(LS_KEY, v); } catch (_) {}
    if (hasChromeStorage) { try { chrome.storage.local.set({ [LS_KEY]: v }); } catch (_) {} }
  }

  // 回填：优先 localStorage；没有再看 chrome.storage（重装后恢复）。
  keyInput.value = readLocal();
  if (!keyInput.value && hasChromeStorage) {
    try {
      chrome.storage.local.get(LS_KEY, (res) => {
        const v = res && res[LS_KEY];
        if (v) { keyInput.value = v; try { localStorage.setItem(LS_KEY, v); } catch (_) {} }
      });
    } catch (_) {}
  }

  settingsBtn.addEventListener("click", () => {
    settingsPanel.hidden = !settingsPanel.hidden;
    if (!settingsPanel.hidden) { keyInput.focus(); statusEl.textContent = ""; statusEl.className = "settings-status"; }
  });

  function save() {
    const v = keyInput.value.trim();
    writeKey(v);
    statusEl.textContent = v ? "✓ 已保存，可以开始使用了" : "已清空口令";
    statusEl.className = "settings-status ok";
  }
  saveKeyBtn.addEventListener("click", save);
  keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
})();
// 打开弹窗时自动聚焦输入框（autofocus 在 Chrome 弹窗里偶尔失效，下一帧兜底）
requestAnimationFrame(() => sourceText.focus());
