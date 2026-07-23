// 练习页：从润色收藏（corrections）复习，两种模式：
//   复述练习(replay)：题面用 situation 真实情境 → 你用英文表达 → /judge 判意图命中。
//   泛化练习(transfer)：用收藏的泛化情境(situations[])出新场景 → 判断是否调用同一 pattern。
//   判定走后端 /judge（意图命中，非字面比对）；连不上时退回本地词级比对兜底。
const STORAGE_KEY = "corrections";
const GOOGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const JUDGE_API = "http://127.0.0.1:8770/judge";
const PASS_THRESHOLD = 0.85; // 本地兜底比对的过关命中率

const stageEl = document.querySelector("#stage");
const progressEl = document.querySelector("#progress");

let mode = "replay";  // 'replay' 复述 / 'transfer' 泛化
let queue = [];      // 待过关队列（元素是收藏条目，答错会重新入队尾）
let current = null;  // 当前题 { ...item, prompt, askSituation }
let passed = 0;      // 已过关条数
let total = 0;       // 本轮范围内总条数
let misses = 0;      // 累计"没过"次数（含重考）

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function getCorrections() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (res) => resolve(res[STORAGE_KEY] || {}));
  });
}

// 把英文 better 翻成中文，作为句子题题面。失败时返回空。
async function toChinese(text) {
  try {
    const url = `${GOOGLE_ENDPOINT}?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) return "";
    const data = await res.json();
    const segs = (data && data[0]) || [];
    return segs.map((s) => (s && s[0]) || "").join("");
  } catch (_) {
    return "";
  }
}


// 把时间戳归到「今天 / 昨天 / 前天 / 具体日期」分组标签（与收藏页一致）。
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

// 发音：朗读正确答案。优先 macOS 自带高质量美音（与收藏页一致）。
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


// 把句子拆成小写词（去标点），用于宽松比对——天然忽略大小写与标点。
function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// 单词级 LCS 比对：标出对/多/漏的词，返回命中比例。忽略大小写与标点。
function compareAnswer(your, answer) {
  const a = tokenize(your);
  const b = tokenize(answer);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const yourMarks = [], answerMarks = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      yourMarks.push({ w: a[i], ok: true });
      answerMarks.push({ w: b[j], hit: true });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      yourMarks.push({ w: a[i], ok: false });
      i++;
    } else {
      answerMarks.push({ w: b[j], hit: false });
      j++;
    }
  }
  while (i < n) yourMarks.push({ w: a[i++], ok: false });
  while (j < m) answerMarks.push({ w: b[j++], hit: false });
  const matched = answerMarks.filter((x) => x.hit).length;
  const score = m ? matched / m : 0;
  const yourHtml = yourMarks
    .map((x) => `<span class="${x.ok ? "w-ok" : "w-bad"}">${escapeHtml(x.w)}</span>`).join(" ");
  const answerHtml = answerMarks
    .map((x) => `<span class="${x.hit ? "w-ok" : "w-miss"}">${escapeHtml(x.w)}</span>`).join(" ");
  return { score, yourHtml, answerHtml };
}

// 一条收藏是「单词题」还是「句子题」：润色收藏没有 word 字段，
// 统一按句子题处理（看中文默写英文）。保留判断以便将来扩展单词题。
function isWordItem(item) {
  return item && item.kind === "word" && item.word;
}


let allItems = []; // 全部可练收藏（有 better 的），用于范围选择

// 模式选择页：先选「复述练习 / 泛化练习」。
function renderModePicker() {
  stageEl.innerHTML = `
    <div class="card">
      <div class="kind-label">选择练习模式</div>
      <div class="mode-grid">
        <button class="mode-btn" data-mode="replay" type="button">
          <span class="mode-name">复述练习</span>
          <span class="mode-desc">回到当时的情境，把学过的表达再说出来</span>
        </button>
        <button class="mode-btn" data-mode="transfer" type="button">
          <span class="mode-name">泛化练习</span>
          <span class="mode-desc">换一个新场景，看你能不能用上同一个表达思路</span>
        </button>
      </div>
    </div>`;
  progressEl.textContent = "";
  stageEl.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      mode = btn.dataset.mode;
      renderRangePicker();
    });
  });
}

// 范围选择页：按时间线分组列出，每组带条数 + 一个「全部」。
function renderRangePicker() {
  // 泛化模式只能练「有泛化情境」的收藏；复述模式全部可练。
  const pool = mode === "transfer"
    ? allItems.filter((it) => Array.isArray(it.situations) && it.situations.length)
    : allItems;
  if (mode === "transfer" && !pool.length) {
    stageEl.innerHTML = `
      <div class="card">
        <div class="kind-label">泛化练习</div>
        <div class="empty">还没有可做泛化练习的收藏。<br/>新收藏会自动带「同类新场景」，收藏几条新的再来练。</div>
        <div class="actions"><button class="btn-ghost" id="backMode" type="button">返回</button></div>
      </div>`;
    stageEl.querySelector("#backMode").addEventListener("click", renderModePicker);
    progressEl.textContent = "";
    return;
  }
  const groups = new Map(); // label -> count
  for (const it of pool) {
    const label = dayLabel(it.savedAt);
    groups.set(label, (groups.get(label) || 0) + 1);
  }
  const groupBtns = [...groups.entries()]
    .map(([label, count]) =>
      `<button class="range-btn" data-range="${escapeHtml(label)}" type="button">
         <span class="range-name">${escapeHtml(label)}</span>
         <span class="range-count">${count} 条</span>
       </button>`)
    .join("");

  stageEl.innerHTML = `
    <div class="card">
      <div class="kind-label">${mode === "transfer" ? "泛化练习 · 选择范围" : "复述练习 · 选择范围"}</div>
      <div class="prompt" style="font-size:18px;margin-bottom:14px">练到全部过关为止</div>
      <div class="range-grid">
        <button class="range-btn range-all" data-range="__all__" type="button">
          <span class="range-name">全部</span>
          <span class="range-count">${pool.length} 条</span>
        </button>
        ${groupBtns}
      </div>
      <div class="actions"><button class="btn-ghost" id="backMode" type="button">‹ 换模式</button></div>
    </div>`;
  progressEl.textContent = "";
  stageEl.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => startRound(btn.dataset.range));
  });
  stageEl.querySelector("#backMode").addEventListener("click", renderModePicker);
}

// 进入一轮复习：按范围筛出条目，洗牌入队。
function startRound(range) {
  const pool = mode === "transfer"
    ? allItems.filter((it) => Array.isArray(it.situations) && it.situations.length)
    : allItems;
  const items = range === "__all__"
    ? pool.slice()
    : pool.filter((it) => dayLabel(it.savedAt) === range);
  if (!items.length) { renderRangePicker(); return; }
  // 洗牌
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  queue = items;
  total = items.length;
  passed = 0;
  misses = 0;
  current = null;
  nextQuestion();
}

function updateProgress() {
  progressEl.textContent = `已过关 ${passed}/${total} · 队列剩 ${queue.length} · 没过 ${misses} 次`;
}

// 取队首作为当前题；队列空 = 全部过关，结算。
// 题面：复述用 situation（无则机翻 better 兜底）；泛化随机取该条的一个泛化情境。
async function nextQuestion() {
  if (!queue.length) { renderDone(); return; }
  const pick = queue.shift();
  current = { ...pick, prompt: "" };
  const asked = current;

  if (mode === "transfer") {
    // 泛化：从该条的泛化情境里随机选一个当新场景题面。
    const list = Array.isArray(pick.situations) ? pick.situations : [];
    current.prompt = list.length ? list[Math.floor(Math.random() * list.length)] : (pick.situation || pick.intent || "");
    renderQuestion();
    return;
  }
  // 复述：优先用 situation（真实情境），其次 intent，最后机翻 better 兜底。
  if (pick.situation) {
    current.prompt = pick.situation;
    renderQuestion();
  } else if (pick.intent) {
    current.prompt = pick.intent;
    renderQuestion();
  } else {
    renderQuestion(); // 先渲染占位，再异步翻译
    const zh = await toChinese(pick.better);
    if (current === asked && zh) {
      current.prompt = zh;
      const promptEl = stageEl.querySelector(".prompt");
      if (promptEl) promptEl.textContent = zh;
    }
  }
}

// 过关：计入 passed，进入下一题。未过：重新排队尾，misses+1。
function markPass() { passed++; updateProgress(); nextQuestion(); }
function markFail() { misses++; queue.push(stripExtra(current)); updateProgress(); nextQuestion(); }
function stripExtra(item) { const { prompt, ...rest } = item; return rest; }

function renderQuestion() {
  const kind = mode === "transfer" ? "新场景 · 用上学过的表达思路" : "回到这个情境，用英文表达";
  const hint = mode === "transfer"
    ? "这是一个新场景，但能用到你学过的某个表达方式。试着说出来。"
    : "回忆当时你想怎么说，写出你的英文。";
  stageEl.innerHTML = `
    <div class="card">
      <div class="kind-label">${kind}</div>
      <div class="prompt">${escapeHtml(current.prompt || "（题面准备中…）")}</div>
      <div class="prompt-hint">${hint}</div>
      <textarea id="answer" placeholder="在这里写英文…" autofocus></textarea>
      <div class="actions">
        <button class="btn-primary" id="submitBtn" type="button">提交</button>
        <button class="btn-ghost" id="quitBtn" type="button">退出</button>
      </div>
    </div>`;
  const answerEl = stageEl.querySelector("#answer");
  answerEl.focus();
  answerEl.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  });
  stageEl.querySelector("#submitBtn").addEventListener("click", submit);
  stageEl.querySelector("#quitBtn").addEventListener("click", renderRangePicker);
  updateProgress();
}

// 提交：优先调 /judge 做意图命中判定；连不上则退回本地词级比对兜底。
async function submit() {
  const your = (stageEl.querySelector("#answer") || {}).value || "";
  const submitBtn = stageEl.querySelector("#submitBtn");
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "判定中…"; }

  // 可接受答案集：better + 各语气版本。
  const accepted = [current.better, ...(Array.isArray(current.tones) ? current.tones.map((t) => t.text) : [])]
    .filter(Boolean);

  let judged = null;
  try {
    const resp = await fetch(JUDGE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: current.intent || current.situation || "", accepted, yours: your, mode }),
    });
    if (resp.ok) judged = await resp.json();
  } catch (_) { /* 退回本地兜底 */ }

  if (judged) {
    renderJudgeResult(your, judged);
  } else {
    renderLocalResult(your); // 兜底
  }
  updateProgress();
}

// 模型判定结果渲染：命中/部分命中/未命中 + 你做得好的 + 差距 + 学到的地道说法。
function renderJudgeResult(your, j) {
  const isPass = j.hit === true;
  const cls = isPass ? "ok" : (j.level === "部分命中" ? "near" : "miss");
  const learned = j.learned || current.better || "";
  const yourBlock = your.trim()
    ? `<div class="answer-text">${escapeHtml(your)}</div>`
    : `<div class="answer-text" style="color:#9aa0c0">（空）</div>`;
  const okLine = j.yours_ok ? `<div class="note">👍 ${escapeHtml(j.yours_ok)}</div>` : "";
  const gapLine = j.gap ? `<div class="note">💡 ${escapeHtml(j.gap)}</div>` : "";
  const nextLabel = isPass ? "下一题" : "记下，稍后重考";
  stageEl.innerHTML = `
    <div class="card">
      <div class="kind-label">${mode === "transfer" ? "新场景" : "情境"}</div>
      <div class="prompt" style="font-size:16px">${escapeHtml(current.prompt || "")}</div>
      <div class="result">
        <div class="verdict ${cls}">${escapeHtml(j.level || (isPass ? "命中" : "未命中"))}</div>
        <div class="answer-block"><div class="answer-label">你说的</div>${yourBlock}</div>
        <div class="answer-block">
          <div class="answer-label">${mode === "transfer" ? "你学过的地道说法" : "地道说法"}</div>
          <div class="answer-text">${escapeHtml(learned)}
            <button class="speak" id="speakBtn" title="朗读">🔊</button>
          </div>
        </div>
        ${okLine}
        ${gapLine}
      </div>
      <div class="actions">
        <button class="btn-primary" id="nextBtn" type="button">${nextLabel}</button>
      </div>
    </div>`;
  stageEl.querySelector("#speakBtn").addEventListener("click", () => speak(learned));
  stageEl.querySelector("#nextBtn").addEventListener("click", isPass ? markPass : markFail);
  speak(learned);
}

// 本地兜底（模型连不上）：词级比对 better，仅复述模式有意义。
function renderLocalResult(your) {
  const { score, yourHtml, answerHtml } = compareAnswer(your, current.better);
  const isPass = score >= PASS_THRESHOLD;
  const cls = isPass ? "ok" : (score >= 0.5 ? "near" : "miss");
  const label = isPass ? "过关！" : (score >= 0.5 ? "差一点，没过" : "差得有点多，没过");
  const note = current.note ? `<div class="note">${escapeHtml(current.note)}</div>` : "";
  const yourBlock = your.trim()
    ? `<div class="answer-text">${yourHtml}</div>`
    : `<div class="answer-text" style="color:#9aa0c0">（空）</div>`;
  const nextLabel = isPass ? "下一题" : "记下，稍后重考";
  stageEl.innerHTML = `
    <div class="card">
      <div class="kind-label">情境（离线判定）</div>
      <div class="prompt" style="font-size:16px">${escapeHtml(current.prompt || current.input || "")}</div>
      <div class="result">
        <div class="verdict ${cls}">${label}（命中 ${Math.round(score * 100)}%）</div>
        <div class="answer-block"><div class="answer-label">你写的</div>${yourBlock}</div>
        <div class="answer-block">
          <div class="answer-label">地道说法</div>
          <div class="answer-text">${answerHtml}
            <button class="speak" id="speakBtn" title="朗读">🔊</button>
          </div>
        </div>
        ${note}
      </div>
      <div class="actions">
        <button class="btn-primary" id="nextBtn" type="button">${nextLabel}</button>
      </div>
    </div>`;
  stageEl.querySelector("#speakBtn").addEventListener("click", () => speak(current.better));
  stageEl.querySelector("#nextBtn").addEventListener("click", isPass ? markPass : markFail);
  speak(current.better);
}

function renderDone() {
  stageEl.innerHTML = `
    <div class="card">
      <div class="kind-label">本轮完成</div>
      <div class="prompt">全部过关 🎉</div>
      <div class="done-stat">共 ${total} 条 · 过程中没过 ${misses} 次</div>
      <div class="actions">
        <button class="btn-primary" id="againBtn" type="button">再来一轮</button>
      </div>
    </div>`;
  progressEl.textContent = "";
  stageEl.querySelector("#againBtn").addEventListener("click", renderModePicker);
}

function renderEmpty() {
  stageEl.innerHTML = `
    <div class="card">
      <div class="empty">还没有可练习的收藏。<br/>先在插件里润色几句话并点 ☆ 收藏，再回来练习。</div>
    </div>`;
  progressEl.textContent = "";
}

async function init() {
  const map = await getCorrections();
  allItems = Object.entries(map)
    .map(([key, value]) => ({ key, ...value }))
    .filter((it) => it && it.better && it.better.trim())
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  if (!allItems.length) { renderEmpty(); return; }
  renderModePicker();
}

init();

