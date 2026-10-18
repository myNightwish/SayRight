// 练习页：从润色收藏（corrections）复习，两种模式：
//   复述练习(replay)：题面用 situation 真实情境 → 你用英文表达。
//   泛化练习(transfer)：用收藏的泛化情境(situations[])出新场景 → 用同一 pattern 造句。
//   判定完全交给用户自评（对照地道说法后点「我答对了 / 没答对」）——机器判不准，你说了算。
const STORAGE_KEY = "corrections";
const GOOGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const SERVER_ORIGIN = window.NUANCE_MODEL_ORIGIN || location.origin;
const POLISH_API = `${SERVER_ORIGIN}/polish`; // 复习时「换个情境提示」：把 better 回喂 /polish，只取新的 situation(s)
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
const DRILL_KEY = "drillState"; // 跨会话按条掌握度（Leitner 盒子），跟随云同步
const PASS_THRESHOLD = 0.85;    // 本地词级比对的软建议阈值：≥此值默认高亮「我答对了」，仅作提示
const GROUP_SIZE = 15;          // 一组复习的题量：到期优先，不足用新条补满，最多 15，控制单次时长与同步时机
const DAY = 86400000;
// Leitner 间隔（天），按 box 索引：box1..5。box0 = 全新未练。答对推后一格，答错回 box1。
const BOX_DAYS = [0, 1, 2, 4, 7, 15];

const stageEl = document.querySelector("#stage");
const progressEl = document.querySelector("#progress");

let mode = "replay";  // 'replay' 复述 / 'transfer' 泛化
let drillMap = {};   // drillId -> { box, due, reps, lapses, savedAt }；drillId = `${item.key}::${mode}`
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
  if (hasChromeStorage) return new Promise((r) => chrome.storage.local.set({ [STORAGE_KEY]: map }, r));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (_) {}
  return Promise.resolve();
}

// ---- 掌握度调度态（drillState）读写：与 corrections 同款兜底 ----
function getDrillState() {
  return new Promise((resolve) => {
    if (hasChromeStorage) {
      chrome.storage.local.get(DRILL_KEY, (res) => resolve(res[DRILL_KEY] || {}));
    } else {
      try { resolve(JSON.parse(localStorage.getItem(DRILL_KEY) || "{}")); }
      catch (_) { resolve({}); }
    }
  });
}
function setDrillState(map) {
  if (hasChromeStorage) return new Promise((r) => chrome.storage.local.set({ [DRILL_KEY]: map }, r));
  try { localStorage.setItem(DRILL_KEY, JSON.stringify(map)); } catch (_) {}
  return Promise.resolve();
}

// 一条收藏在某个模式下的调度 id。复述/泛化各自独立记忆（同一句在两种练法下掌握度不同）。
function drillIdOf(item, m) { return `${item.key}::${m || mode}`; }

// Leitner 更新：答对推后一格、答错拉回 box1。只落地本地 drillState（不逐题上行网络）。
// 一组题的掌握度改动攒在本地，整组做完后由 flushGroupSync() 一次性上行——大幅减少 /sync 调用。
// 本地已先持久化，即便中途退出也不丢：下次开页/切后台的 flushSync 会补传。
async function scheduleUpdate(item, m, isPass) {
  const id = drillIdOf(item, m);
  const now = Date.now();
  const prev = drillMap[id] || { box: 0, due: 0, reps: 0, lapses: 0 };
  let box = prev.box || 0;
  let lapses = prev.lapses || 0;
  const reps = (prev.reps || 0) + 1;
  if (isPass) box = Math.min(5, box + 1);
  else { box = 1; lapses += 1; }
  const interval = BOX_DAYS[box] || 0;
  drillMap[id] = { box, due: now + interval * DAY, reps, lapses, savedAt: now };
  await setDrillState(drillMap);
}

// 整组掌握度攒完后，一次性上行同步（组结算 / 中途退出时调用）。
function flushGroupSync() {
  try { window.NuanceSync && window.NuanceSync.syncNow(); } catch (_) {}
}

// 复习时重生成「情境提示」：早期收藏的 situation 可能不贴切（那会儿 prompt 还没优化）。
// 把这条的 better 回喂 /polish（用它自己的 scene/tone），只取模型新给的 situation / situations，
// 覆盖到收藏里并落地 + 同步。当前题的 prompt 也一并刷新。成功返回 true。
async function refreshSituation(item) {
  if (!item || !item.better) return false;
  let parsed = null;
  try {
    const resp = await fetch(POLISH_API, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        text: item.better,
        scene: item.scene || "",
        tone: item.tone || "",
        strictness: "easy", // 只为重取情境，不需要严格挑刺
      }),
    });
    if (resp.ok) parsed = await resp.json();
  } catch (_) { return false; }
  if (!parsed || (!parsed.situation && !Array.isArray(parsed.situations))) return false;

  const map = await getCorrections();
  const saved = map[item.key];
  if (!saved) return false;
  if (parsed.situation) saved.situation = parsed.situation;
  if (Array.isArray(parsed.situations) && parsed.situations.length) saved.situations = parsed.situations;
  // 换情境只是「就地改」一条已有收藏，不该把它挪到今天的日期分组里。
  // 日期分组看 createdAt（收藏那天，永不变）；savedAt 只服务同步的 savedAt-wins。
  // 老数据没有 createdAt，首次改动时用当前 savedAt 补写，锁住它原来的日期。
  if (!saved.createdAt) saved.createdAt = saved.savedAt || Date.now();
  saved.savedAt = Date.now(); // bump 让同步 savedAt-wins 把新情境传出去（不影响日期分组）
  await setCorrections(map);
  try { window.NuanceSync && window.NuanceSync.syncSoon(); } catch (_) {}

  // 同步更新内存里的 allItems 与当前题，避免本轮还用旧情境。
  const mem = allItems.find((x) => x.key === item.key);
  if (mem) { if (parsed.situation) mem.situation = parsed.situation; if (saved.situations) mem.situations = saved.situations; }
  if (current && current.key === item.key) {
    if (parsed.situation) current.situation = parsed.situation;
    if (saved.situations) current.situations = saved.situations;
    // 复述题用 situation；泛化题从 situations 里随机取一个新场景。
    if (mode === "transfer") {
      const list = saved.situations || [];
      current.prompt = list.length ? list[Math.floor(Math.random() * list.length)] : (parsed.situation || current.prompt);
    } else {
      current.prompt = parsed.situation || current.prompt;
    }
  }
  return true;
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
let starOnly = false; // 「只练核心」：只练打了星（产出核心）的收藏——练习优先服务产出核心

// 星级：0=只在接收库；1–5=产出核心。兼容早期布尔 starred（视作 3 星）。
function starLevelOf(it) {
  if (!it) return 0;
  if (typeof it.stars === "number") return it.stars;
  return it.starred ? 3 : 0;
}

// 当前练习池：按模式过滤（泛化需有泛化情境）+ 可选只练产出核心。
function currentPool() {
  let pool = mode === "transfer"
    ? allItems.filter((it) => Array.isArray(it.situations) && it.situations.length)
    : allItems;
  if (starOnly) pool = pool.filter((it) => starLevelOf(it) >= 1);
  return pool;
}

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

// 范围选择页：改为「调度驱动」。顶部两个主选项：今日复习（到期+新条）/ 全部练一遍；
// 下方保留按时间线分组，想定向补练某天仍可点。
function renderRangePicker() {
  // 泛化模式只能练「有泛化情境」的收藏；复述模式全部可练。可叠加「只练核心」。
  const pool = currentPool();
  const starTotal = allItems.filter((it) => starLevelOf(it) >= 1).length;
  if (mode === "transfer" && !pool.length && !starOnly) {
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

  // 分桶统计（按当前模式的 drillId）。练过的＝有 drillState 的条目：
  //   mastered 已掌握（到了最长间隔 box5）· learning 巩固中（练过、未到期、box<5）
  //   due 待复习（练过、已到期）· fresh 全新（从未练过）
  // 一组最多 GROUP_SIZE 题，从「待复习 + 全新」里取（到期优先）。
  const now = Date.now();
  let due = 0, fresh = 0, learning = 0, mastered = 0;
  for (const it of pool) {
    const st = drillMap[drillIdOf(it, mode)];
    if (!st) { fresh++; continue; }
    if ((st.due || 0) <= now) { due++; continue; }
    if ((st.box || 0) >= 5) mastered++; else learning++;
  }
  const poolTotal = pool.length;
  const practiced = poolTotal - fresh;            // 练过的（有掌握度记录）
  const todo = due + fresh;                        // 还要做的：到期 + 全新
  const groupN = Math.min(GROUP_SIZE, todo);       // 这一组带入的题量
  const remainGroups = Math.ceil(todo / GROUP_SIZE);
  const pct = poolTotal ? Math.round((practiced / poolTotal) * 100) : 0;
  const todayDesc = groupN
    ? `到期 ${due} · 全新 ${fresh} · 还剩约 ${remainGroups} 组`
    : "到期和全新都清空了，可全部再练一遍";

  const groups = new Map(); // label -> { count, practiced }
  for (const it of pool) {
    const label = dayLabel(it.createdAt || it.savedAt);
    const g = groups.get(label) || { count: 0, practiced: 0 };
    g.count++;
    if (drillMap[drillIdOf(it, mode)]) g.practiced++;
    groups.set(label, g);
  }
  const groupBtns = [...groups.entries()]
    .map(([label, g]) => {
      const doneAll = g.practiced >= g.count;
      return `<button class="range-btn ${doneAll ? "range-done" : ""}" data-range="${escapeHtml(label)}" type="button">
         <span class="range-name">${escapeHtml(label)}${doneAll ? " ✓" : ""}</span>
         <span class="range-count">${g.practiced}/${g.count} 已练</span>
       </button>`;
    })
    .join("");

  stageEl.innerHTML = `
    <div class="card">
      <div class="kind-label">${mode === "transfer" ? "泛化练习" : "复述练习"}</div>
      <div class="mastery">
        <div class="mastery-head">
          <span>已练 <b>${practiced}</b> / ${poolTotal}</span>
          <span>${pct}%</span>
        </div>
        <div class="mastery-bar"><div class="mastery-fill" style="width:${pct}%"></div></div>
        <div class="mastery-legend">
          <span class="lg lg-mastered">已掌握 ${mastered}</span>
          <span class="lg lg-learning">巩固中 ${learning}</span>
          <span class="lg lg-due">待复习 ${due}</span>
          <span class="lg lg-fresh">全新 ${fresh}</span>
        </div>
      </div>
      <button class="star-toggle ${starOnly ? "on" : ""}" id="starToggle" type="button"
        ${starTotal ? "" : "disabled"} title="只练打了星、晋升进产出核心的高频表达">
        ${starOnly ? "★ 只练核心" : "☆ 只练核心"} · ${starTotal} 条
      </button>
      <div class="range-grid">
        <button class="range-btn range-all" data-range="__due__" type="button" ${groupN ? "" : "disabled"}>
          <span class="range-name">复习一组${groupN ? ` · ${groupN} 题` : ""}</span>
          <span class="range-count">${todayDesc}</span>
        </button>
        <button class="range-btn range-cram" data-range="__all__" type="button" ${pool.length ? "" : "disabled"}>
          <span class="range-name">全部练一遍</span>
          <span class="range-count">${pool.length} 条</span>
        </button>
      </div>
      <div class="range-sub">或挑某天定向补练</div>
      <div class="range-grid">
        ${groupBtns}
      </div>
      <div class="actions"><button class="btn-ghost" id="backMode" type="button">‹ 换模式</button></div>
    </div>`;
  progressEl.textContent = "";
  const starToggle = stageEl.querySelector("#starToggle");
  if (starToggle) {
    starToggle.addEventListener("click", () => {
      if (starToggle.disabled) return;
      starOnly = !starOnly;
      renderRangePicker();   // 重渲染：统计与列表都跟着「只练核心」变
    });
  }
  stageEl.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => { if (!btn.disabled) startRound(btn.dataset.range); });
  });
  stageEl.querySelector("#backMode").addEventListener("click", renderModePicker);
}

// 进入一轮复习：按范围筛出条目，洗牌入队。
//   __due__ = 一组（GROUP_SIZE 题）：到期条（due<=now）优先，不足用新条（无 drillState）补满——按遗忘曲线收敛薄弱项。
//   __all__ = 全部（考前突击）。其它 = 某天分组。
function startRound(range) {
  const pool = currentPool();
  let items;
  if (range === "__due__") {
    const now = Date.now();
    const dueItems = [], newItems = [];
    for (const it of pool) {
      const st = drillMap[drillIdOf(it, mode)];
      if (!st) newItems.push(it);
      else if ((st.due || 0) <= now) dueItems.push(it);
    }
    // 到期优先塞满一组；还差多少用新条补。整组不超过 GROUP_SIZE。
    items = dueItems.slice(0, GROUP_SIZE);
    if (items.length < GROUP_SIZE) {
      items = items.concat(newItems.slice(0, GROUP_SIZE - items.length));
    }
  } else if (range === "__all__") {
    items = pool.slice();
  } else {
    items = pool.filter((it) => dayLabel(it.createdAt || it.savedAt) === range);
  }
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
// 两者都按当前模式记一次 Leitner 调度（答对推后、答错拉近），只落地本地；整组做完再一次性上行。
function markPass() { scheduleUpdate(current, mode, true); passed++; updateProgress(); nextQuestion(); }
function markFail() { scheduleUpdate(current, mode, false); misses++; queue.push(stripExtra(current)); updateProgress(); nextQuestion(); }
function stripExtra(item) { const { prompt, ...rest } = item; return rest; }

// 复习中删除这条收藏：库里确实不值得学的就地移除。删除要尽快传播（否则被别端旧数据复活），故立即上行。
async function deleteCurrent() {
  const victim = current;
  if (!victim || !victim.key) return;
  const map = await getCorrections();
  delete map[victim.key];
  await setCorrections(map);
  if (window.NuanceSync) window.NuanceSync.recordDelete(victim.key); // 记墓碑 + 立即上行
  // 从内存池、队列里也剔除，避免本组稍后再抽到它。
  allItems = allItems.filter((x) => x.key !== victim.key);
  queue = queue.filter((x) => x.key !== victim.key);
  total = Math.max(passed, total - 1);
  updateProgress();
  nextQuestion();
}

// 结果页的裁定按钮：没有机器判定了，完全你自评。左「我答对了」右「没答对，重考」。
// suggestPass 仅作视觉提示（哪个高亮），来自本地词级比对，点谁都行。
function verdictActionsHtml(suggestPass) {
  const passCls = suggestPass ? "btn-primary" : "btn-ghost";
  const failCls = suggestPass ? "btn-ghost" : "btn-primary";
  return `
    <div class="verdict-hint">对照上面的地道说法，自己判定这次算不算过</div>
    <div class="actions">
      <button class="${passCls}" id="passBtn" type="button">✓ 我答对了</button>
      <button class="${failCls}" id="failBtn" type="button">✕ 没答对，重考</button>
    </div>
    <button class="quiz-del" id="delBtn" type="button" title="这条不值得学？从收藏里删掉">🗑 删掉这条，不再复习</button>`;
}
function bindVerdictActions() {
  const p = stageEl.querySelector("#passBtn");
  const f = stageEl.querySelector("#failBtn");
  const d = stageEl.querySelector("#delBtn");
  if (p) p.addEventListener("click", markPass);
  if (f) f.addEventListener("click", markFail);
  if (d) d.addEventListener("click", deleteCurrent);
}

function renderQuestion() {
  const kind = mode === "transfer" ? "新场景 · 用上学过的表达思路" : "回到这个情境，用英文表达";
  const hint = mode === "transfer"
    ? "这是一个新场景，但能用到你学过的某个表达方式。试着说出来。"
    : "回忆当时你想怎么说，写出你的英文。";
  stageEl.innerHTML = `
    <div class="card">
      <button class="quiz-del-icon" id="delIcon" type="button" title="删掉这条，不再复习">🗑</button>
      <div class="kind-label">${kind}</div>
      <div class="prompt">${escapeHtml(current.prompt || "（题面准备中…）")}</div>
      <div class="prompt-hint">${hint}</div>
      <button class="refresh-situation" id="refreshSituation" type="button" title="这条情境提示不贴切？换一个">🔄 换个情境提示</button>
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
  stageEl.querySelector("#quitBtn").addEventListener("click", quitRound);
  stageEl.querySelector("#delIcon").addEventListener("click", deleteCurrent);
  // 换个情境提示：重新生成 situation 并覆盖收藏，成功后就地更新题面文字。
  const refreshBtn = stageEl.querySelector("#refreshSituation");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      const asked = current;
      refreshBtn.disabled = true;
      refreshBtn.textContent = "重新生成中…";
      const ok = await refreshSituation(asked);
      if (current !== asked) return; // 已翻到下一题，忽略这次回填
      const promptEl = stageEl.querySelector(".prompt");
      if (ok && promptEl) promptEl.textContent = current.prompt || "";
      refreshBtn.disabled = false;
      refreshBtn.textContent = ok ? "🔄 再换一个" : "🔄 换个情境提示";
      if (!ok) { refreshBtn.textContent = "换失败，重试"; }
    });
  }
  updateProgress();
}

// 提交：不再调 /judge（判不准且慢）。本地词级比对只用来高亮对/漏词并给个软建议，
// 最终对错由你对照「地道说法」自评。
function submit() {
  const your = (stageEl.querySelector("#answer") || {}).value || "";
  renderResult(your);
  updateProgress();
}

// 结果页：展示你写的（高亮对/多/漏词）+ 地道说法（可朗读）+ 收藏时的 note，
// 然后你自评对错。suggestPass 由本地比对分给出，仅决定哪个按钮高亮。
function renderResult(your) {
  const { score, yourHtml, answerHtml } = compareAnswer(your, current.better);
  const isPass = score >= PASS_THRESHOLD;
  const cls = isPass ? "ok" : (score >= 0.5 ? "near" : "miss");
  const label = isPass ? "看起来对上了" : (score >= 0.5 ? "差一点" : "差得有点多");
  const note = current.note ? `<div class="note">${escapeHtml(current.note)}</div>` : "";
  const yourBlock = your.trim()
    ? `<div class="answer-text">${yourHtml}</div>`
    : `<div class="answer-text" style="color:#9aa0c0">（空）</div>`;
  stageEl.innerHTML = `
    <div class="card">
      <div class="kind-label">${mode === "transfer" ? "新场景" : "情境"}</div>
      <div class="prompt" style="font-size:16px">${escapeHtml(current.prompt || current.input || "")}</div>
      <div class="result">
        <div class="verdict ${cls}">${label}（词面命中 ${Math.round(score * 100)}%，仅供参考）</div>
        <div class="answer-block"><div class="answer-label">你写的</div>${yourBlock}</div>
        <div class="answer-block">
          <div class="answer-label">${mode === "transfer" ? "你学过的地道说法" : "地道说法"}</div>
          <div class="answer-text">${answerHtml}
            <button class="speak" id="speakBtn" title="朗读">🔊</button>
          </div>
        </div>
        ${note}
      </div>
      ${verdictActionsHtml(isPass)}
    </div>`;
  stageEl.querySelector("#speakBtn").addEventListener("click", () => speak(current.better));
  bindVerdictActions();
  speak(current.better);
}

function renderDone() {
  flushGroupSync(); // 整组做完，把这组攒下的掌握度一次性上行
  stageEl.innerHTML = `
    <div class="card">
      <div class="kind-label">本组完成</div>
      <div class="quiz-state-media">
        <img src="images/mascot-success-v1.gif" alt="Coco 正在庆祝本组练习完成" />
        <div>
          <div class="prompt">这一组过完啦</div>
          <div class="done-stat">共 ${total} 题 · 过程中没过 ${misses} 次</div>
        </div>
      </div>
      <div class="actions">
        <button class="btn-primary" id="againBtn" type="button">再来一组</button>
      </div>
    </div>`;
  progressEl.textContent = "";
  stageEl.querySelector("#againBtn").addEventListener("click", renderRangePicker);
}

// 中途退出：把这组已攒下的掌握度一次性上行，再回到选择页。
function quitRound() {
  flushGroupSync();
  renderRangePicker();
}

function renderEmpty() {
  stageEl.innerHTML = `
    <div class="card">
      <div class="empty quiz-state-media">
        <img src="images/mascot-comfort-v2.png" alt="Coco 正在等你添加练习内容" />
        <span>还没有可练习的收藏。<br/>先润色并收藏几句话，再回来练习。</span>
      </div>
    </div>`;
  progressEl.textContent = "";
}

async function init() {
  const [map, dstate] = await Promise.all([getCorrections(), getDrillState()]);
  drillMap = dstate || {};
  allItems = Object.entries(map)
    .map(([key, value]) => ({ key, ...value }))
    .filter((it) => it && it.better && it.better.trim())
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  if (!allItems.length) { renderEmpty(); return; }
  renderModePicker();
}

// 云同步写回后（别端更新了收藏或掌握度）刷新本地态；练习途中不打断，仅更新数据。
window.addEventListener("nuance:synced", async () => {
  const [map, dstate] = await Promise.all([getCorrections(), getDrillState()]);
  drillMap = dstate || {};
  allItems = Object.entries(map)
    .map(([key, value]) => ({ key, ...value }))
    .filter((it) => it && it.better && it.better.trim())
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
});

init();

