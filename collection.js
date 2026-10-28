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
let collectionView="library";
let queueData={items:[],open:[],history:[]};
let queueDrill={};
const pendingStars=new Set();
const pendingLearningRatings=new Set();

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
    <summary class="card-summary"><button class="card-icon card-delete" data-remove="${escapeHtml(item.key)}" type="button" title="删除这份记录" aria-label="删除这份记录"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button><div class="card-head"><span class="intent-title">${escapeHtml(item.sourceLabel || "本次表达调整")}</span><span class="meta">${rows.length} 处对比 · 不自动复习</span></div><p>${escapeHtml(item.personalContext || "")}</p></summary>
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
  const stateLabel = { inbox: "已收藏", active: "正在练", archived: "归档保留" };
  const starred = item.stars > 0 || Boolean(item.starred);
  const pendingMaterial=studyState==='active'&&!queueData.items.some(x=>x.key===item.key);
  const starBox = `<span class="queue-state ${studyState==='active'&&!pendingMaterial?'is-active':''}">${pendingMaterial?'候补':stateLabel[studyState]}</span>
    <button type="button" class="header-star ${starred?'is-starred':''}" data-toggle-star="${escapeHtml(item.key)}" aria-label="${starred?'取消标星':'标星'}" aria-pressed="${starred}" title="${starred?'取消标星':'标星'}">${starred?'★':'☆'}</button>`;
  const queueActions=pendingMaterial?'<button type="button" class="queue-card-action" data-show-queue>查看候补</button>':collectionView==='queue'?`<span class="queue-card-actions"><button type="button" class="queue-card-action" data-queue-state="inbox" data-queue-key="${escapeHtml(item.key)}">移回表达库</button><button type="button" class="queue-card-action" data-queue-state="archived" data-queue-key="${escapeHtml(item.key)}">归档</button></span>`:studyState==='active'?`<button type="button" class="queue-card-action" data-show-queue>查看正在练</button>`:`<button type="button" class="queue-card-action primary" data-queue-state="active" data-queue-key="${escapeHtml(item.key)}">${studyState==='archived'?'重新标记想练':'标记想练'}</button>`;
  const source = item.sourceLabel ? `<span class="card-source" title="${escapeHtml(item.sourceLabel)}">来源：${/^https?:\/\//.test(item.sourceUrl || "") ? `<a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.sourceLabel)}</a>` : escapeHtml(item.sourceLabel)}</span>` : "";
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

  const extras = [construct, impression, scoresHtml, inputLine, note].filter(Boolean).length;
  const moreHint = extras ? `<span class="more-hint">展开看详情</span>` : "";

  // 整张卡片折叠：<details> 默认收起，只显示摘要（场景标签 + 意图 + 地道说法）。
  // 点标题展开才显示构式/评分/笔记等，一屏能扫更多条、按需深入。
  return `
    <details class="card ${starred ? "starred" : ""}" data-key="${escapeHtml(item.key)}">
      <summary class="card-summary">
        <button class="card-icon card-delete" data-remove="${escapeHtml(item.key)}" type="button" title="删除这条表达" aria-label="删除这条表达"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
        <div class="card-head">
          <div class="title-wrap">
            <span class="card-tags">${sceneTag}${toneTag}${source}</span>
            <span class="title-with-edit"><span class="intent-title">${escapeHtml(title)}</span>
            <button class="card-icon card-edit" data-edit-cue="${escapeHtml(item.key)}" type="button" title="编辑使用情境" aria-label="编辑使用情境"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 6Z"/></svg></button></span>
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
          ${queueActions}
          <span class="chevron" aria-hidden="true">▾</span>
        </div>
      </summary>
      <div class="card-body">
        ${construct}
        ${impression}
        ${scoresHtml}
        ${inputLine}
        ${note}
      </div>
    </details>
  `;
}

function render(items) {
  const openKeys=new Set([...listEl.querySelectorAll("details[data-key][open]")].map(card=>card.dataset.key));
  const expressions=allItems.filter(it => it.origin !== "feedback-session");
  const active = expressions.filter(it => NuanceLearning.stateOf(it) === "active").length;
  const inbox = expressions.filter(it => NuanceLearning.stateOf(it) === "inbox").length;
  const feedbackCount=allItems.length-expressions.length;
  if (!document.querySelector("#paneCorrections").classList.contains("hidden")) countEl.textContent = collectionView==='queue'?(queueData.needsSelection?'本轮待选材料':`${queueData.items.length} 条本轮材料`): `共 ${expressions.length} 条表达 · ${feedbackCount} 次调整记录`;

  if(collectionView==='queue'){
    listNavEl.innerHTML='';
    NuanceWorkspace.render(queueData,{host:listEl,openLibrary:()=>switchTab('corrections'),notice:message=>document.querySelector('#queueStatus').textContent=message,
      admit:async key=>{await NuanceQueueStore.run({type:'admit',key});await load();},
      newWindow:async()=>{await NuanceQueueStore.run({type:'new-window'});await load();},
      rate:async(key,score)=>{pendingLearningRatings.add(key);try{const saved=await NuanceQueueStore.run({type:'rate',key,score});return updateLearningState(saved);}finally{pendingLearningRatings.delete(key);}},
      adopt:async(key,attemptId)=>{await NuanceQueueStore.run({type:'adopt',key,attemptId});await load();},
      check:async input=>{const saved=await NuanceQueueStore.check(input);return {...saved,snapshot:saved.corrections?updateLearningState(saved):queueData};}
    });return;
  }
  if (!items.length) {
    listNavEl.innerHTML = "";
    const message = collectionView==='queue'?(searchEl.value.trim()?'没有匹配的正在练表达。':'先从表达库挑一两条近期想用的表达，不必填满 10 条。'):allItems.length?'没有匹配的收藏。':'暂无收藏。阅读网页或 PDF 时，可以选中表达收藏。';
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
  for(const card of listEl.querySelectorAll("details[data-key]"))if(openKeys.has(card.dataset.key))card.open=true;
}

function applyFilter() {
  const q = searchEl.value.trim().toLowerCase();
  let items = collectionView==='queue'?queueData.items:allItems;
  // 「只看核心」：只留星级≥1（已晋升进产出核心）的。
  if (collectionView==='library' && studyFilter === "feedback") items=items.filter(it => it.origin === "feedback-session");
  else if (collectionView==='library' && studyFilter !== "all") items = items.filter(it => it.origin !== "feedback-session" && NuanceLearning.stateOf(it) === studyFilter);
  if (q) {
    items = items.filter((item) => {
      const hay = `${item.situation || ""} ${item.intent || ""} ${item.scene || ""} ${item.input || ""} ${item.better || ""} ${item.note || ""} ${item.sourceLabel || ""} ${item.personalContext || ""} ${JSON.stringify(item.adjustments || [])}`;
      return hay.toLowerCase().includes(q);
    });
  }
  render(items);
}

async function load({skipUnchanged=false}={}) {
  const beforeWindow=windowSignature(queueData);
  const result=await NuanceQueueStore.run({type:'reconcile'});
  const map=result.corrections;queueDrill=result.drillState;
  queueData=NuanceQueue.snapshot(map,queueDrill);renderQueueOverview();
  const nextItems = Object.entries(map)
    .map(([key, value]) => Object.assign({ key }, value, { key }))
    .sort((a, b) => (b.createdAt || b.savedAt || 0) - (a.createdAt || a.savedAt || 0) || a.key.localeCompare(b.key));
  // A successful sync commonly returns the same local edit; keep the live DOM and focus.
  if(skipUnchanged && JSON.stringify(nextItems)===JSON.stringify(allItems)){if(collectionView==='queue'&&beforeWindow!==windowSignature(queueData))applyFilter();return;}
  allItems=nextItems;
  applyFilter();
}

listEl.addEventListener("click", async (event) => {
  const showQueue=event.target.closest('[data-show-queue]');
  if(showQueue){event.preventDefault();event.stopPropagation();switchTab('queue');return;}
  const queueButton=event.target.closest('[data-queue-state]');
  if(queueButton){
    event.preventDefault();event.stopPropagation();queueButton.disabled=true;
    try{
      await NuanceQueueStore.run({type:'state',key:queueButton.dataset.queueKey,state:queueButton.dataset.queueState});
      document.querySelector('#queueStatus').textContent=queueButton.dataset.queueState==='active'?'已标记想练；本轮已开始时，需在候补中确认补入。':queueButton.dataset.queueState==='archived'?'已归档保留，不会自动补入新表达。':'已移回表达库，收藏与练习历史保留。';
      await load();
    }catch(error){document.querySelector('#queueStatus').textContent=error.message;queueButton.disabled=false;}
    return;
  }
  const star=event.target.closest('[data-toggle-star]');
  if(star){
    event.preventDefault();event.stopPropagation();
    const key=star.dataset.toggleStar;if(pendingStars.has(key))return;
    pendingStars.add(key);star.setAttribute('aria-busy','true');
    try{
      const map=await getCorrections(),item=map[star.dataset.toggleStar];if(!item)return;
      // Preserve legacy learning state: starring is an independent preference.
      item.studyState=NuanceLearning.stateOf(item);
      const enabled=item.stars>0||Boolean(item.starred);
      item.stars=enabled?0:1;item.starred=!enabled;
      item.createdAt ||= item.savedAt||Date.now();item.savedAt=Date.now();
      // Cache the local edit before storage.onChanged can echo it back.
      const cached=allItems.find(x=>x.key===key);if(cached)Object.assign(cached,item);
      const card=star.closest('details');card?.classList.toggle('starred',!enabled);
      star.classList.toggle('is-starred',!enabled);star.textContent=enabled?'☆':'★';
      star.title=star.ariaLabel=enabled?'标星':'取消标星';star.setAttribute('aria-pressed',String(!enabled));
      await setCorrections(map);window.NuanceSync?.syncSoon();
    }catch(_){await load();alert('标星未保存，请重试。');}
    finally{pendingStars.delete(key);star.removeAttribute('aria-busy');}
    return;
  }

  const practice=event.target.closest("[data-feedback-session]");
  if(practice){
    practice.disabled=true;
    try {
      await NuanceQueueStore.run({type:'feedback',sessionKey:practice.dataset.feedbackSession,index:Number(practice.dataset.feedbackIndex)});await load();
      const section=[...listEl.querySelectorAll("details[data-key]")].find(el=>el.dataset.key===practice.dataset.feedbackSession);
      if(section)section.open=true;
    } catch(error) {alert(error.message || "未能保存，请重试");practice.disabled=false;}
    return;
  }
  const edit = event.target.closest("[data-edit-cue]");
  if (edit) {
    event.preventDefault();event.stopPropagation();
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

  const remove = event.target.closest("[data-remove]");
  if (!remove) return;
  event.preventDefault();event.stopPropagation();
  const key = remove.dataset.remove;
  if (!confirm("确定删除这条收藏吗？删除后会同步到其他设备。")) return;
  remove.disabled=true;
  try {
    const map = await getCorrections();
    delete map[key];
    await setCorrections(map);
    if (window.NuanceSync) window.NuanceSync.recordDelete(key);
    await load();
  } catch (_) {alert("删除失败，请重试。");remove.disabled=false;}
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
    if (changes[STORAGE_KEY]||changes.drillState) load({skipUnchanged:true}).catch(queueLoadError);
    if (changes[SCENE_KEY]) loadScenes();
  });
}

// 云同步写回本地后，重渲染两个 tab（拉到别的设备新增/删除的收藏）。
window.addEventListener("nuance:synced", () => { load({skipUnchanged:true}).catch(queueLoadError); loadScenes(); });

load().catch(queueLoadError);

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
  history.replaceState(null,'',tab==='queue'?'#queue':tab==='scenes'?'#scenes':'#library');
  tabScenes.classList.toggle("active", isScenes);
  collectionView=tab==='queue'?'queue':'library';
  document.querySelector('#tabQueue').classList.toggle('active',tab==='queue');
  tabCorrections.classList.toggle("active", !isScenes&&tab!=='queue');
  paneScenes.classList.toggle("hidden", !isScenes);
  paneCorrections.classList.toggle("hidden", isScenes);
  pageTitle.textContent = isScenes ? "我的场景演练收藏" : collectionView==='queue'?'正在练':'我的表达';
  document.querySelector('#queueOverview').hidden=isScenes||collectionView!=='queue';
  document.querySelector('#paneCorrections .toolbar').hidden=collectionView==='queue';
  document.querySelector('#queueHistory').hidden=isScenes||collectionView!=='queue';
  document.querySelector('#studyFilter').closest('label').hidden=collectionView==='queue';
  document.querySelector('#libraryManagement').hidden=collectionView==='queue';
  for(const link of document.querySelectorAll('#paneCorrections .toolbar > a'))link.hidden=collectionView==='queue';
  document.querySelector('#paneCorrections .scene-layout').classList.toggle('is-queue',collectionView==='queue');
  searchEl.placeholder=collectionView==='queue'?'搜索正在练的表达…':'搜索意图、场景、原句或地道说法…';
  document.querySelector('#queueStatus').textContent='';
  if(!isScenes)applyFilter();else countEl.textContent=`共 ${sceneItems.length} 条场景收藏`;
}
tabCorrections.addEventListener("click", () => switchTab("corrections"));
tabScenes.addEventListener("click", () => switchTab("scenes"));
document.querySelector("#tabQueue").addEventListener("click",()=>switchTab("queue"));

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
    .map(([key, value]) => Object.assign({ key }, value, { key }))
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

listEl.addEventListener('change',async event=>{const control=event.target.closest('[data-study-key]');if(!control)return;try{await NuanceQueueStore.run({type:'state',key:control.dataset.studyKey,state:control.value});await load();}catch(error){alert(error.message);await load();}});

const libraryMenu=document.querySelector('.library-management');
document.addEventListener('pointerdown',event=>{if(libraryMenu?.open&&!libraryMenu.contains(event.target))libraryMenu.open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&libraryMenu?.open){libraryMenu.open=false;libraryMenu.querySelector('summary').focus();}});

function renderQueueOverview(){
  const count=queueData.items.length;
  document.querySelector('#queueTabCount').textContent=count;
  document.querySelector('#queueTitle').textContent=`正在练 · ${count} / 10`;
  const start=queueData.open.length?Math.min(...queueData.open.map(x=>x.startedAt)):null;
  document.querySelector('#queueDescription').textContent=`${queueData.readyCount||0} / ${count} 张自评达到 4 分。全部达到 4 分后，可开启情境对话。`;
  document.querySelector('#queueWarning').hidden=true;
  document.querySelector('#endRound').disabled=!queueData.open.length;
  document.querySelector('#manageRound').hidden=!queueData.candidates?.length;
  const dialogue=document.querySelector('#startLearnedDialogue');dialogue.disabled=!queueData.ready;dialogue.textContent=queueData.ready?'开启情境对话':count?`情境对话 · 还差 ${count-(queueData.readyCount||0)} 张达到 4 分`:'情境对话';
  document.querySelector('#roundCount').textContent=queueData.history.length;
  document.querySelector('#roundHistoryList').innerHTML=queueData.history.length?queueData.history.map(round=>`<article class="round-record"><h3>${new Date(round.startedAt).toLocaleDateString('zh-CN')} — ${new Date(round.endedAt).toLocaleDateString('zh-CN')} · ${round.members.size} 条表达</h3><p>${round.endReason==='selection'?'历史标记已整理，原资料保留。':'已结束本轮关注，归档不代表永久掌握。'}</p><ul>${[...round.members.values()].map(item=>`<li>${escapeHtml(item.expression)} <span class="meta">${item.status==='archive'?'归档保留':item.status==='leave'?'已移出':'本轮记录'}</span></li>`).join('')}</ul></article>`).join(''):'<p>结束本轮后，可在这里回看成员记录。</p>';
}
let confirmedBatch=null;
const queueEndDialog=document.querySelector('#queueEndDialog');
document.querySelector('#endRound').addEventListener('click',()=>{
  const keys=queueData.items.map(x=>x.key),roundIds=queueData.open.map(x=>x.id);if(!roundIds.length)return;
  confirmedBatch={keys,roundIds};
  document.querySelector('#queueEndMessage').textContent=`当前 ${keys.length} 条表达将归档保留，不会自动补入新表达。`;
  queueEndDialog.showModal();
});
document.querySelector('#cancelEndRound').addEventListener('click',()=>{confirmedBatch=null;queueEndDialog.close();});
document.querySelector('#confirmEndRound').addEventListener('click',async event=>{
  if(!confirmedBatch)return;const batch=confirmedBatch,button=event.currentTarget;button.disabled=true;
  try{await NuanceQueueStore.run({type:'end',...batch});confirmedBatch=null;queueEndDialog.close();await load();document.querySelector('#queueStatus').textContent='本轮已结束。准备好时，再从表达库选择下一轮。';}
  catch(error){document.querySelector('#queueEndMessage').textContent=error.message;}
  finally{button.disabled=false;}
});
queueEndDialog.addEventListener('cancel',()=>{confirmedBatch=null;});
function queueLoadError(error){document.querySelector('#queueStatus').textContent=error.message||'学习数据暂未加载，请重试。';}

if(location.hash==='#queue')switchTab('queue');else if(location.hash==='#scenes')switchTab('scenes');

document.querySelector('#manageRound').addEventListener('click',()=>NuanceWorkspace.manage());

function windowSignature(value){return JSON.stringify([value.windowId,(value.items||[]).map(x=>[x.key,pendingLearningRatings.has(x.key)?0:x.selfRating]),(value.candidates||[]).map(x=>x.key)]);}
function updateLearningState(saved){queueDrill=saved.drillState;queueData=NuanceQueue.snapshot(saved.corrections,queueDrill);renderQueueOverview();return queueData;}
document.querySelector('#startLearnedDialogue').addEventListener('click',async()=>{
  const saved=await NuanceQueueStore.run({type:'reconcile'}),current=updateLearningState(saved);
  if(!current.ready){document.querySelector('#queueStatus').textContent='本轮所有卡片自评达到 4 分后，再开启对话。';return;}
  location.href='chat.html?rehearse=1&window='+encodeURIComponent(current.windowId)+'&start='+Date.now();
});
document.querySelector('#openPracticeWindow').addEventListener('click',event=>{event.preventDefault();switchTab('queue');});
