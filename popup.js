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

// 渲染可复用表达块（chunks）。兼容老数据：construct 字符串当单个 skeleton 块。
// 每块显示：块文本（槽位高亮）+ 类型标 + 中文用途；升级点(isUpgrade)特别高亮。
function renderChunks(result) {
  let chunks = Array.isArray(result.chunks) ? result.chunks : [];
  if (!chunks.length && result.construct) {
    chunks = [{ text: result.construct, type: "skeleton", label: "", isUpgrade: false }];
  }
  if (!chunks.length) return "";
  const typeLabel = { fixed: "固定表达", skeleton: "句型骨架", semi: "半固定" };
  const rows = chunks
    .map((c) => {
      const t = ["fixed", "skeleton", "semi"].includes(c.type) ? c.type : "skeleton";
      const up = c.isUpgrade ? `<span class="chunk-up">✨ 你可能想不到</span>` : "";
      const label = c.label ? `<span class="chunk-label">${escapeHtml(c.label)}</span>` : "";
      return `
        <div class="chunk-row ${c.isUpgrade ? "upgrade" : ""}">
          <div class="chunk-text">${highlightSlots(c.text)}</div>
          <div class="chunk-meta"><span class="chunk-type ${t}">${typeLabel[t]}</span>${label}${up}</div>
        </div>`;
    })
    .join("");
  return `<div class="chunks"><div class="chunks-title">可复用表达</div>${rows}</div>`;
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
  const chunksHtml = renderChunks(result);
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
  const html = `${impression}<div class="polish-better">${better}</div>${chunksHtml}${scoresHtml}${note}${tonesHtml}`;
  setResult(result.better || "", html);

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

// 根据当前润色结果是否已收藏，刷新星标外观。
async function refreshSaveButton() {
  if (!currentPolish) {
    saveButton.hidden = true;
    return;
  }
  saveButton.hidden = false;
  const map = await getCorrections();
  const saved = Boolean(map[correctionKey(currentPolish.input)]);
  saveButton.classList.toggle("active", saved);
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
  } else {
    // 收藏「表达意图」：除原句/better/note 外，存场景、意图、印象、评分、语气版本，
    // 为将来与 Trace 的「应用可视化」打通保留结构。
    map[key] = {
      input: currentPolish.input,
      scene: currentPolish.scene || "通用",
      tone: currentPolish.tone || "自然",
      intent: currentPolish.intent || "",
      situation: currentPolish.situation || "",
      situations: Array.isArray(currentPolish.situations) ? currentPolish.situations : [],
      better: currentPolish.better || "",
      chunks: Array.isArray(currentPolish.chunks) ? currentPolish.chunks : [],
      note: currentPolish.note || "",
      impression: currentPolish.impression || "",
      scores: currentPolish.scores || null,
      tones: Array.isArray(currentPolish.tones) ? currentPolish.tones : [],
      natural: Boolean(currentPolish.natural),
      savedAt: Date.now(),
    };
  }
  await setCorrections(map);
  await refreshSaveButton();
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

  try {
    const translatedText = await translateText(text, direction);
    setResult(translatedText);
  } catch (error) {
    console.error(error);
    setResult("");
    setCopyButtonState("error");
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

  try {
    const result = await polishExpression(text, sceneSelect.value, toneSelect.value, strictnessSelect.value);
    // 记录本次润色（含场景/语气），供收藏与渲染用
    currentPolish = { input: text, scene: sceneSelect.value, tone: toneSelect.value, ...result };
    renderPolish(result);
    refreshSaveButton();
  } catch (error) {
    console.error(error);
    const msg =
      error.message === "NO_SERVER"
        ? "润色服务未启动，请先运行 tutor-server（见 README）。"
        : `润色失败：${error.message}`;
    setResult("", `<div class="polish-hint">${escapeHtml(msg)}</div>`);
    setCopyButtonState("error");
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
