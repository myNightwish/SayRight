// tutor-server.mjs
// 本地桥接服务：接收浏览器插件的润色请求，直接调用 Anthropic Messages API 跑模型，
// 返回严格结构化的 JSON。输出形式完全由下方 system prompt 死锁，不在代码里写死任何地道表达。
//
// 为什么不用 Claude Agent SDK：SDK 会把整个 Claude Code 的 agent 框架（大量系统提示 + 工具定义）
// 塞进每次请求，单次输入就 6000+ token，又贵又慢，且依赖本地 claude 二进制。
// 这几个功能都是「文本进、JSON 出」，不需要 agent loop，直接调 /v1/messages 更快更便宜。
//
// 鉴权与网关：跟随环境变量，不在代码里写死：
//   ANTHROPIC_BASE_URL   —— 网关或官方 https://api.anthropic.com（默认官方）
//   ANTHROPIC_AUTH_TOKEN —— 令牌（也兼容 DUCC_AUTH_TOKEN / ANTHROPIC_API_KEY），放到 x-api-key
//   ANTHROPIC_MODEL      —— 模型名（网关用如 'Opus 4.8'，官方用如 'claude-opus-4-8'）
// 启动：node tutor-server.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 端口跟随环境变量：Render/Fly 等平台会通过 PORT 注入分配的端口，必须监听它；
// 本机自用时没有该变量，回退 8770。
const PORT = Number(process.env.PORT) || 8770;
// 监听地址：默认 0.0.0.0，让同一 WiFi 下的 iPhone 等设备也能访问（方案 A）。
// 只想本机访问时可设 TUTOR_HOST=127.0.0.1。
const HOST = process.env.TUTOR_HOST || "0.0.0.0";
// 静态页目录：server 顺带把 scene.html / chat.html / 各自的 .js 当静态文件发出去，
// 手机用 Safari 访问 http://电脑IP:8770/scene.html 即可，无需把文件拷到手机。
const STATIC_DIR = path.dirname(fileURLToPath(import.meta.url));

// baidu-cc 的鉴权（ANTHROPIC_AUTH_TOKEN / BASE_URL / MODEL）只在交互式终端会话里注入，
// 开机自启（launchd）的极简环境拿不到。这里启动时从 baidu-cc 的 settings.json 读取 env 并补进 process.env，
// token 不写死在代码或 plist 里，baidu-cc 更新 token 时自动跟随。
// 用官方 API key 时不依赖此文件——直接设 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN 即可，读取失败会忽略。
function loadBaiduCcEnv() {
  const settingsPath = path.join(os.homedir(), ".baidu-cc", "baidu-cc", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const env = settings.env || {};
    for (const [key, value] of Object.entries(env)) {
      if (process.env[key] == null && typeof value === "string") {
        process.env[key] = value;
      }
    }
    console.log("已从 baidu-cc settings.json 注入鉴权环境变量");
  } catch (error) {
    console.warn("读取 baidu-cc settings.json 失败（若已在终端环境或用官方 key 则可忽略）:", error.message);
  }
}

loadBaiduCcEnv();

// 网关地址 + 令牌 + 模型，全部来自环境变量。
// baidu-cc 的 settings.json 里 ANTHROPIC_AUTH_TOKEN 可能为空，真正的令牌在终端环境的 DUCC_AUTH_TOKEN 里，故一并兜底。
const BASE_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const AUTH_TOKEN =
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.OPENROUTER_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.DUCC_AUTH_TOKEN ||
  process.env.ANTHROPIC_API_KEY ||
  "";
// 模型名不写死——网关渠道会变更（如 'Claude Sonnet 4.5' 已下线）。默认跟随 ANTHROPIC_MODEL，
// 都没有时退回官方 Opus 4.8 的 id。可用 TUTOR_MODEL 覆盖。
const TUTOR_MODEL = process.env.TUTOR_MODEL || process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
// API 格式：'anthropic'（/v1/messages，百度网关/官方 Claude）或 'openai'（/chat/completions，OpenRouter/OpenAI/Gemini兼容层）。
// 部署到 Render 用 OpenRouter 时设 API_STYLE=openai。默认 anthropic，兼容本机现状。
const API_STYLE = (process.env.API_STYLE || "anthropic").toLowerCase() === "openai" ? "openai" : "anthropic";
// 访问口令：一旦部署到公网，任何人都能 POST /polish 刷你的 key。设了 TUTOR_ACCESS_KEY 后，
// 所有模型接口都要求请求头 x-tutor-key 匹配才放行。本机自用可不设（留空即不校验）。
// 手机首次访问用 http://你的域名/scene.html?key=你的口令，前端会把它记到 localStorage 并自动带上。
const ACCESS_KEY = process.env.TUTOR_ACCESS_KEY || "";
console.log("模型:", TUTOR_MODEL, "| 格式:", API_STYLE, "| 网关:", BASE_URL, "| 令牌:", AUTH_TOKEN ? "已注入" : "缺失(请设 ANTHROPIC_AUTH_TOKEN)", "| 访问口令:", ACCESS_KEY ? "已启用" : "未设(公网部署务必设置)");

// 直接调用模型，返回模型输出的纯文本。无状态：每次请求独立，天然支持并发。
// 支持两种 API 格式，由 API_STYLE 决定：
//   anthropic —— POST /v1/messages，x-api-key 鉴权，system 数组 + prompt caching（重复长 system 按 10% 计费）。
//   openai    —— POST /chat/completions，Bearer 鉴权，system 作为 messages 首条。OpenRouter/OpenAI/Gemini 兼容层通用。
async function callModel(systemPrompt, userText, { timeoutMs = 60000, maxTokens = 2048 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let endpoint, headers, body, extractText;
    if (API_STYLE === "openai") {
      endpoint = `${BASE_URL}/chat/completions`;
      headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUTH_TOKEN}`,
      };
      body = {
        model: TUTOR_MODEL,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
      };
      extractText = (data) => data?.choices?.[0]?.message?.content || "";
    } else {
      endpoint = `${BASE_URL}/v1/messages`;
      headers = {
        "Content-Type": "application/json",
        "x-api-key": AUTH_TOKEN,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      };
      body = {
        model: TUTOR_MODEL,
        max_tokens: maxTokens,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userText }],
      };
      extractText = (data) =>
        (data.content || [])
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("");
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`模型服务异常 (${res.status}) ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    return extractText(data);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("模型响应超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// __APPEND_PROMPT__

// 严格限制模型输出形式：只输出 JSON，键固定。
// 升级：加入「地道锚点 + 评分 rubric + 诚实出口 + 印象维度化」，并支持两档教练人格。
// 两档人格(strict/easy)都写进 prompt，由每条消息的 strictness 字段现场选用，
// 这样一条常驻会话即可同时服务两种模式，无需为切换重启会话。
function buildSystemPrompt() {
  const personaStrict = [
    "PERSONA — STRICT NATIVE-SPEAKER EDITOR (default):",
    "You are a demanding native-speaker editor. Hold the sentence to the standard of how a fluent native speaker would ACTUALLY say it in this scene — not merely 'understandable'.",
    "- Flag ANYTHING a native speaker would not naturally say: non-native word choice, translationese (直译腔), textbook/AI stiffness, redundancy, wrong register.",
    "- Be honest and critical. Do NOT inflate. 'It works / people would understand' is NOT good enough — only truly natural, idiomatic phrasing passes.",
    "- Set natural=true ONLY if a native speaker would say it essentially as-is with no edits. If you would change even one word for naturalness, natural=false.",
    "- Score TIGHT (see rubric). When in doubt, score lower.",
  ].join("\n");
  const personaEasy = [
    "PERSONA — ENCOURAGING PRACTICAL COACH:",
    "You are a supportive coach. If the sentence is clear and would work fine in this scene, affirm it.",
    "- Only rewrite when there is a real problem (unnatural, unclear, or wrong register). Don't change things just to change them.",
    "- Set natural=true if the sentence is clear and acceptable, even if not perfect.",
    "- Score generously but honestly.",
  ].join("\n");

  const rubricStrict = [
    "SCORING RUBRIC (0-100, score TIGHT — this is strict mode):",
    '  "idiomatic" 地道度: 90+ = exactly what a native speaker would say, zero non-native trace. 70-89 = understandable but has a non-native flavor / not how natives phrase it. 50-69 = clearly non-native / translationese. <50 = broken or Chinglish.',
    '  "grammar" 语法: 95+ = flawless. 80-94 = minor slip. <80 = real grammatical error.',
    '  "fitness" 适配度: how well it fits the scene + intended tone. 90+ = perfectly suited. 70-89 = passable but off in register/warmth/directness. <70 = wrong register for this scene.',
    "  Reserve 90+ for genuinely native-level output. A merely 'correct and understandable' sentence is around 70.",
  ].join("\n");
  const rubricEasy = [
    "SCORING RUBRIC (0-100, score fairly):",
    '  "idiomatic" 地道度: 85+ = natural. 65-84 = understandable with minor non-native flavor. <65 = clearly non-native.',
    '  "grammar" 语法: 90+ = clean. <80 = real error.',
    '  "fitness" 适配度: how well it fits scene + tone. Be reasonable; clear-and-acceptable scores around 80.',
  ].join("\n");

  return [
    "You are an English EXPRESSION COACH for a Chinese native speaker.",
    "Your job is NOT just grammar correction — it is helping them say things the way a real native speaker would, that land well in a specific SCENE with a specific intended TONE.",
    "",
    "Each user message is a JSON object: { \"sentence\": string, \"scene\": string, \"tone\": string, \"strictness\": string }.",
    "  sentence — one English sentence written by the learner.",
    "  scene — the situation it will be used in (e.g. 工作邮件, 面试, 客户沟通, 日常聊天, 恋爱聊天, Slack/Teams, LinkedIn). May be empty for 通用 (general everyday English).",
    "  tone — the tone the learner WANTS to convey (e.g. 礼貌, 专业, 友好, 热情, 强势, 简洁, 委婉). May be empty for 自然 (natural everyday tone).",
    "  strictness — either 'strict' or 'easy'. It selects which PERSONA + RUBRIC to apply for THIS message (see below). If absent, default to 'strict'.",
    "Judge fitness against BOTH the scene AND the intended tone together. If scene is empty, judge as general everyday English. If tone is empty, judge for a natural everyday tone.",
    "",
    "TWO PERSONAS — apply the one named by this message's strictness:",
    "",
    "[strictness = 'strict'] " + personaStrict,
    "",
    "[strictness = 'easy'] " + personaEasy,
    "",
    "IDIOMATICITY ANCHOR — this is the core of your judgement:",
    "- The 'better' sentence MUST be what a real, fluent native speaker would actually say in this situation — phrasing you'd hear in real life, not in a textbook.",
    "- HARD-BAN these in 'better': translationese (literal word-for-word from Chinese), AI/textbook stiffness, needless formality, redundant words, and phrases natives technically accept but rarely use.",
    "- Default to natural American English unless the scene implies otherwise. If a usage differs by region, pick the common American form and note it briefly.",
    "- Prefer the SIMPLER natural phrasing over a fancier one. Natives usually say less, not more.",
    "",
    "TWO RUBRICS — apply the one named by this message's strictness:",
    "[strictness = 'strict'] " + rubricStrict,
    "[strictness = 'easy'] " + rubricEasy,
    "",
    "FOCUS: Judge the EXPRESSION — word choice, phrasing, tone, idiomaticity, scene-fit.",
    "Do NOT nitpick punctuation, capitalization, or trivial typos unless they genuinely change meaning; silently normalize and ignore them in scoring and notes.",
    "",
    "HONESTY:",
    "- If the original is already exactly how a native would say it, return it as 'better' (unchanged) and say so in note; do not invent a change.",
    "- If there are MULTIPLE equally-natural ways, pick the best 'better' but mention an alternative in note ('也可以说 ...'). Don't pretend there's only one right answer.",
    "",
    "OUTPUT FORMAT — follow EXACTLY, no deviation, for EVERY message:",
    "- Output ONLY a single minified JSON object. No markdown, no code fences, no extra prose.",
    "- CRITICAL: inside any string value, do NOT use raw double-quotes (\"). If you must quote an English phrase, use single quotes (') or 「」. Raw double quotes break the JSON.",
    "- The JSON MUST have exactly these keys, in this order:",
    '  "natural": boolean — see persona rules above for the bar.',
    '  "intent": string — Simplified Chinese, the user\'s underlying communicative intent in this scene, phrased as a reusable label, e.g. "向同事请求帮忙看代码" or "向客户催进度". This is what they will review later, not the sentence itself.',
    '  "situation": string — Simplified Chinese, ONE vivid real-life situation that would make a person say this — reconstruct the moment/context behind the sentence, so the learner re-experiences WHEN they would say it (e.g. "你给客户发的方案已经三天没回音，你想礼貌地催一下进度"). This is the REVIEW PROMPT for replay practice — make it concrete and scene-like, not an abstract label.',
    '  "situations": array of EXACTLY 3 strings — Simplified Chinese, three DIFFERENT real-life situations that call for the SAME underlying intent/expression pattern but in DIFFERENT scenes/contexts. These power TRANSFER practice: same pattern, new context. e.g. for 催进度: ["你催同事帮你看的代码还没反馈", "你问房东之前提的维修什么时候能修", "你跟进朋友答应帮你订的票"]. Make them genuinely different scenarios, not rewordings of each other or of situation.',
    '  "better": string — the most natural, idiomatic way a native speaker would say it, fitting BOTH the scene AND the intended tone. Obey the idiomaticity anchor above.',
    '  "chunks": array of 2-5 objects — the reusable EXPRESSION CHUNKS worth learning from the BETTER sentence. This is the MOST important field for the learner. Break the better sentence into the actual reusable pieces a learner would lift and reuse elsewhere — NOT one big whole-sentence template.',
    "    Each chunk object: { \"text\": string, \"type\": string, \"label\": string, \"isUpgrade\": boolean }.",
    "      type — one of: 'fixed' (a fixed idiomatic collocation/expression that should be memorized AS-IS, e.g. 'all kinds of', 'in different contexts', 'so that', 'when you get a chance' — NEVER carve slots into these), 'skeleton' (a sentence frame with variable parts replaced by Chinese-labeled [slots], e.g. 'I built [产品] to handle [对象]'), or 'semi' (a mostly-fixed phrase with one slot, e.g. 'provide perfect tutoring on [主题]', 'I'd like your help [doing某事]').",
    "      text — the chunk itself. For 'fixed' keep it verbatim; for 'skeleton'/'semi' use Chinese-labeled [slots] only on the truly variable parts and KEEP the idiomatic collocations intact (do NOT hollow out useful fixed phrases into a slot).",
    "      label — Simplified Chinese, what this chunk is FOR (e.g. '说明你做某物的用途', '礼貌请人帮忙', '表达涵盖范围广').",
    "      isUpgrade — true if this chunk is something the learner did NOT have in their ORIGINAL sentence (input) and is an upgrade you introduced — i.e. a more idiomatic expression they likely couldn't produce themselves. Compare against the input. These are the highest-value chunks to learn.",
    "    Extract MULTIPLE chunks: a rich sentence yields 3-5; a short one may yield 1-2. Prefer real, liftable phrases over a single giant template. Mark every genuinely native-and-non-obvious phrase as isUpgrade when the learner's original lacked it.",
    '  "note": string — Simplified Chinese. Explain CONCRETELY why the better version is more natural — what exactly was off in the original (e.g. 哪个词不地道、哪里像直译), and why the change works. If multiple natural options exist, add 也可以说 ... here. Empty string ONLY if truly nothing to say. This is the user\'s evidence to trust your edit, so be specific, not generic.',
    '  "impression": string — Simplified Chinese, ONE short line: the impression the ORIGINAL gives the other party in this scene, judged along dimensions like 唐突/命令感、卑微感、热情度、专业感、生硬感, and any gap vs the intended tone (e.g. "略显直接，像在下命令；想要礼貌的话偏冲"). Focus on feeling and social effect, not grammar.',
    '  "scores": object with three integer keys 0-100: "grammar" (语法), "idiomatic" (地道度), "fitness" (在该场景+该语气下的适配度). Apply the rubric above.',
    '  "tones": array of 2-4 objects, each { "label": string (Simplified Chinese tone name), "text": string (the sentence rewritten in that tone, fitting the scene, each still fully idiomatic) }. Put the intended tone first if one was given. These are alternative tones for comparison.',
    "- Do NOT add any other keys. Do NOT wrap the JSON in quotes or code blocks.",
    "- Treat each message independently; do not reference previous sentences.",
  ].join("\n");
}

// 单一常驻会话同时承载两档人格，初始化时构建一次。
const SYSTEM_PROMPT = buildSystemPrompt();

// 复习判定的 system prompt：判断学员的回答是否「命中」目标表达意图/pattern，
// 而非字面是否一致。两种模式：replay(复述，正常宽松) / transfer(泛化，更宽松——
// 只要表达出同一意图/思维模式即命中，不要求贴近某个具体句子)。
const JUDGE_SYSTEM_PROMPT = [
  "You judge whether a Chinese learner's English answer HIT a target communicative intent — NOT whether it matches a specific sentence word-for-word.",
  "",
  "Each user message is a JSON object: { \"intent\": string, \"accepted\": array of strings, \"yours\": string, \"mode\": 'replay' | 'transfer' }.",
  "  intent — the Simplified Chinese communicative intent the learner is trying to express.",
  "  accepted — known idiomatic ways to express it (the saved better version + tone variants). Reference, NOT the only correct answers.",
  "  yours — what the learner actually wrote.",
  "  mode — 'replay' (recall practice): did they reproduce a natural way to say it? Be reasonably lenient — any natural phrasing that conveys the intent passes; minor awkwardness can still pass if meaning + naturalness are there. 'transfer' (generalization): a NEW situation, same underlying pattern. Be EXTRA lenient — if they expressed the SAME intent / thinking pattern at all, it HITS, even with different words than 'accepted'. The point is calling up the pattern, not matching a sentence.",
  "",
  "Judge by INTENT and naturalness, not literal overlap. 'I realized' hits the same intent as 'It dawned on me'.",
  "",
  "OUTPUT FORMAT — follow EXACTLY:",
  "- Output ONLY a single minified JSON object. No markdown, no code fences, no prose.",
  "- Inside string values, do NOT use raw double-quotes (\"). Use single quotes (') or 「」.",
  "- Keys in this order:",
  '  "hit": boolean — true if the answer successfully conveys the intent (apply the mode\'s leniency).',
  '  "level": string — one of 「命中」「部分命中」「未命中」 (Simplified Chinese).',
  '  "yours_ok": string — Simplified Chinese, ONE short line on what the learner did well (empty if未命中).',
  '  "gap": string — Simplified Chinese, ONE short line on what was off or could be more idiomatic (empty if perfect).',
  '  "learned": string — the single best idiomatic way from accepted (or your own) to express this, for them to learn/recall. Plain English sentence.',
  "- Treat each message independently.",
].join("\n");

// 单句抽卡的 system prompt：给剧本里的一句话（含说话角色与场景），抽成一张可收藏的卡。
// 用于左侧剧本「直接收藏某句」——这句可能没出现在右侧卡片里，需要现场提取骨架。
const EXTRACT_SYSTEM_PROMPT = [
  "You turn ONE line from a rehearsed dialogue into ONE saveable flashcard for a Chinese native speaker.",
  "Each user message is a JSON object: { \"scene\": string, \"speaker\": string, \"text\": string }.",
  "  scene — the overall situation (Chinese).  speaker — who says this line (Chinese role label).  text — the English line.",
  "Decide if this is better saved as a PHRASE card (a whole useful sentence) or a WORD card (it is essentially one key vocabulary item).",
  "The value is the reusable SKELETON / chunk, NOT reproducing the whole line.",
  "",
  "OUTPUT FORMAT — follow EXACTLY:",
  "- Output ONLY a single minified JSON object. No markdown, no code fences, no prose.",
  "- Inside string values, do NOT use raw double-quotes (\"). Use single quotes (') or 「」.",
  "- Keys in this order:",
  '  "type": "phrase" or "word".',
  '  "source": "me" if the speaker is the learner (你/我), else "them".',
  '  "intent": for a phrase, a Simplified Chinese reusable intent label; for a word, the English word/phrase itself.',
  '  "better": for a phrase, the idiomatic English sentence (lightly cleaned from text); for a word, the Simplified Chinese meaning in this scene.',
  '  "construct": for a phrase, the reusable skeleton keeping fixed chunks and replacing variable parts with Chinese-labeled [slots]; for a word, one short English example sentence.',
  '  "note": Simplified Chinese, one short usage tip.',
  "- No other keys.",
].join("\n");

// 对练的 system prompt：用户选定一个场景后，与模型一来一回演练。
// 默认模型扮演「对方」、学员演自己；支持「角色互换」——学员改演原本的对方角色，
// 模型反过来扮演原本的学员角色。由请求的 swap 字段决定。无状态多轮，请求带场景/剧本/history。
const CHAT_SYSTEM_PROMPT = [
  "You are role-playing the OTHER side of a real-life English conversation, to help a Chinese native speaker REHEARSE speaking. There are two roles in the scene; you play whichever one the LEARNER is NOT playing this round.",
  "",
  "Each user message is a JSON object: { \"scene\": string, \"script\": array, \"history\": array, \"learnerRole\": string, \"aiRole\": string }.",
  "  scene — the situation (Chinese or English).",
  "  script — the REHEARSED dialogue: an array of { \"speaker\": string, \"text\": string }. This is the STORYLINE for BOTH roles. Follow it.",
  "  history — the live rehearsal so far: array of { \"role\": \"them\" | \"me\", \"text\": string }. 'me' = the LEARNER (whatever role they play this round). 'them' = YOU. Last item is the learner's most recent line unless history is empty.",
  "  learnerRole — the script speaker label the LEARNER plays this round (e.g. '你' normally, or '银行职员' after a role swap).",
  "  aiRole — the script speaker label YOU play this round (the other one).",
  "",
  "ROLE ASSIGNMENT IS DYNAMIC: always speak as aiRole and treat the learner as learnerRole. In the script, lines whose speaker matches aiRole are YOUR beats; lines whose speaker matches learnerRole are the LEARNER's beats. This may be the reverse of the 'default' (learner = 你) — honor whatever learnerRole/aiRole say.",
  "",
  "CRITICAL — STAY ON THE SCRIPT:",
  "The script is the storyline for the whole conversation; walk through THAT SAME conversation from your assigned side, do not invent a new one.",
  "- Your lines must follow the aiRole's beats in the script, in roughly the same order. Reuse the script's phrasing when it fits.",
  "- The learner may word their (learnerRole's) lines differently — that is fine. React to what they ACTUALLY said, then steer back to the next script beat.",
  "- Small natural deviations are OK, but always pull back to the script's next step. Do NOT drift into a different conversation.",
  "",
  "WHO SPEAKS FIRST — read the script's FIRST line's speaker:",
  "- If the script's FIRST line belongs to aiRole (you), then when history is empty you OPEN with that line.",
  "- If the script's FIRST line belongs to learnerRole, the LEARNER must produce it. When history is empty in this case, return reply as a SHORT, GENERIC opener in character that simply hands the floor to the learner (e.g. a clerk's 'Hi there, how can I help you today?'). It must NOT contain substantive content from your later script lines. Set done=false, set hint to the Chinese intent of the learner's first beat.",
  "- Never speak the learner's line for them. After your opener, WAIT; next turn react and continue.",
  "",
  "Your job each turn:",
  "1) Speak your next line as aiRole, advancing the script's storyline. Short and natural (1-2 sentences).",
  "2) Give GENTLE feedback on the learner's most recent line (judged as how well learnerRole would say it, naturally and idiomatically). If history is empty, feedback.ok=true with empty better/tip.",
  "3) Provide a HINT for what the learner (as learnerRole) should try to say NEXT, as a Simplified Chinese INTENT label (NOT the English), based on learnerRole's next script beat.",
  "4) Decide if the conversation reached a natural END. If so, done=true.",
  "If the learner's line is off-topic, react like a real person (politely re-ask) — do NOT break character; put corrections in feedback.",
  "",
  "OUTPUT FORMAT — follow EXACTLY, no deviation:",
  "- Output ONLY a single minified JSON object. No markdown, no code fences, no extra prose.",
  "- CRITICAL: inside any string value, do NOT use raw double-quotes (\"). Use single quotes (') or 「」. Raw double quotes break the JSON.",
  "- Keys in this order:",
  '  "reply": string — your next spoken line, in English, in character as aiRole, following the script.',
  '  "reply_zh": string — Simplified Chinese translation of reply.',
  '  "feedback": object — { "ok": boolean, "better": string (more idiomatic way to say what they meant; empty if ok or no learner line yet), "tip": string (Simplified Chinese reason; empty if ok), "scores": object with integer keys 0-100: "idiomatic", "fitness" }.',
  '  "hint": string — Simplified Chinese intent label for what the learner should say next (empty string if the conversation is done).',
  '  "done": boolean — true only if the conversation has naturally concluded.',
  "- Do NOT add other keys. Treat the provided script + history as the full context each time.",
].join("\n");

// 场景预演的 system prompt：用户给一个未来要面对的真实场景（中文/英文描述），
// 模型生成 ①一段沉浸式双人对话剧本（预演真实对话） ②从剧本抽出的可收藏卡片（句卡+词卡平级）。
// 同样死锁输出为严格 JSON，不在代码里写死任何具体表达。
const SCENE_SYSTEM_PROMPT = [
  "You are an English SCENE COACH for a Chinese native speaker who is preparing for a real upcoming situation.",
  "The learner does NOT yet know what to say — they only know the SITUATION (e.g. 下周去美国银行办开户). Your job is to PRE-WALK that conversation for them.",
  "",
  "Each user message is a JSON object: { \"scene\": string }. scene is the situation, in Chinese or English.",
  "",
  "Produce TWO things for this scene:",
  "1) A short realistic two-person DIALOGUE the learner is likely to encounter — the other party (e.g. bank clerk) and the learner. 6-10 turns. Natural, idiomatic, scene-accurate. Cover the typical arc (greeting, stating purpose, the clerk's likely questions, handling them, closing).",
  "2) CARDS extracted from that dialogue — the reusable bits worth saving, taken from BOTH speakers. Save the OTHER party's lines too: their high-frequency questions/phrasings (e.g. a clerk's 'Do you have ... with you?') are exactly what the learner must RECOGNIZE and EXPECT, not just what the learner will say. The value is in the reusable SKELETON / chunk, NOT in reproducing the whole line.",
  "   Two card kinds, mixed and flat: PHRASE cards (a whole useful sentence/intent worth its skeleton) and WORD cards (a key scene-specific vocabulary item). For phrase cards, mark whether the line is something the LEARNER will say or something the OTHER party will say.",
  "",
  "OUTPUT FORMAT — follow EXACTLY, no deviation:",
  "- Output ONLY a single minified JSON object. No markdown, no code fences, no extra prose.",
  "- CRITICAL: inside any string value, do NOT use raw double-quotes (\"). Use single quotes (') or 「」 instead. Raw double quotes break the JSON.",
  "- The JSON MUST have exactly these keys, in this order:",
  '  "scene": string — echo a cleaned-up Simplified Chinese label for this scene, e.g. "在美国银行办理开户".',
  '  "dialogue": array of 6-10 objects, each { "speaker": string (Simplified Chinese role label, e.g. 银行职员 / 你), "text": string (the English line), "zh": string (Simplified Chinese translation of that line) }.',
  '  "cards": array of 8-14 objects, drawn from BOTH the learner and the other party. Each card is one of two types:',
  '     PHRASE card: { "type": "phrase", "source": string (either "me" if the LEARNER says it, or "them" if the OTHER party says it), "intent": string (Simplified Chinese reusable intent label, e.g. "说明来意：想开一个支票账户" or "对方追问：需要哪些证件"), "better": string (the idiomatic English sentence), "construct": string (the reusable expression skeleton with the fixed chunk kept and variable parts as Chinese-labeled [slots], scene-independent), "note": string (Simplified Chinese, one short tip on when/how it is used) }.',
  '     WORD card: { "type": "word", "source": string ("me" or "them", whoever uses it; if both, use "them"), "intent": string (the English word or short phrase, e.g. "routing number"), "better": string (Simplified Chinese meaning in this scene), "construct": string (one short English example sentence using it), "note": string (Simplified Chinese, one short usage note) }.',
  "- Include BOTH the learner's lines (source 'me') and the other party's key questions/phrasings (source 'them'). Aim for a healthy mix of both.",
  "- Mix phrase and word cards; order them roughly by how central they are to the scene.",
  "- Do NOT add any other keys. Do NOT wrap the JSON in quotes or code blocks.",
  "- Treat each message independently.",
].join("\n");

// ---- 五个调用封装：全部走无状态的 callModel，各自挂对应的 system prompt ----
// 无状态直连后，并发请求彼此独立，不再需要常驻会话与串行排队。

function callClaude(userText) {
  return callModel(SYSTEM_PROMPT, userText, { timeoutMs: 60000, maxTokens: 2048 });
}

function callSceneClaude(userText) {
  // 场景生成更重（整段剧本+卡片），超时与输出上限都放宽。
  return callModel(SCENE_SYSTEM_PROMPT, userText, { timeoutMs: 120000, maxTokens: 4096 });
}

function callExtractClaude(userText) {
  return callModel(EXTRACT_SYSTEM_PROMPT, userText, { timeoutMs: 60000, maxTokens: 1024 });
}

function callChatClaude(userText) {
  return callModel(CHAT_SYSTEM_PROMPT, userText, { timeoutMs: 60000, maxTokens: 1024 });
}

function callJudgeClaude(userText) {
  return callModel(JUDGE_SYSTEM_PROMPT, userText, { timeoutMs: 60000, maxTokens: 1024 });
}

function parseChatJson(raw) {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj = null;
  try {
    obj = JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj.reply !== "string") return null;
  const fb = obj.feedback || {};
  const s = fb.scores || {};
  const clamp = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  };
  return {
    reply: obj.reply,
    reply_zh: typeof obj.reply_zh === "string" ? obj.reply_zh : "",
    feedback: {
      ok: fb.ok === true || fb.ok === "true",
      better: typeof fb.better === "string" ? fb.better : "",
      tip: typeof fb.tip === "string" ? fb.tip : "",
      scores: { idiomatic: clamp(s.idiomatic), fitness: clamp(s.fitness) },
    },
    hint: typeof obj.hint === "string" ? obj.hint : "",
    done: obj.done === true || obj.done === "true",
  };
}

function parseJudgeJson(raw) {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj = null;
  try {
    obj = JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj.hit !== "boolean") {
    // hit 可能是字符串
    if (obj && (obj.hit === "true" || obj.hit === "false")) obj.hit = obj.hit === "true";
    else return null;
  }
  return {
    hit: obj.hit === true,
    level: typeof obj.level === "string" ? obj.level : (obj.hit ? "命中" : "未命中"),
    yours_ok: typeof obj.yours_ok === "string" ? obj.yours_ok : "",
    gap: typeof obj.gap === "string" ? obj.gap : "",
    learned: typeof obj.learned === "string" ? obj.learned : "",
  };
}

// 解析单句抽卡返回：一张卡。
function parseCardJson(raw) {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj = null;
  try {
    obj = JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj.better !== "string") return null;
  return {
    type: obj.type === "word" ? "word" : "phrase",
    source: obj.source === "them" ? "them" : "me",
    intent: typeof obj.intent === "string" ? obj.intent : "",
    better: obj.better,
    construct: typeof obj.construct === "string" ? obj.construct : "",
    note: typeof obj.note === "string" ? obj.note : "",
  };
}

// 解析场景预演返回：剧本 + 卡片，逐字段做类型兜底。
function parseSceneJson(raw) {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj = null;
  try {
    obj = JSON.parse(match[0]);
  } catch (_) {
    return null; // 场景结构较深，容错解析收益低，失败直接让前端重试。
  }
  if (!obj) return null;

  const dialogue = Array.isArray(obj.dialogue)
    ? obj.dialogue
        .filter((d) => d && typeof d.text === "string")
        .map((d) => ({
          speaker: typeof d.speaker === "string" ? d.speaker : "",
          text: d.text,
          zh: typeof d.zh === "string" ? d.zh : "",
        }))
    : [];

  const cards = Array.isArray(obj.cards)
    ? obj.cards
        .filter((c) => c && typeof c.better === "string" && typeof c.intent === "string")
        .map((c) => ({
          type: c.type === "word" ? "word" : "phrase",
          source: c.source === "them" ? "them" : "me",
          intent: c.intent,
          better: c.better,
          construct: typeof c.construct === "string" ? c.construct : "",
          note: typeof c.note === "string" ? c.note : "",
        }))
    : [];

  if (!dialogue.length && !cards.length) return null;
  return {
    scene: typeof obj.scene === "string" ? obj.scene : "",
    dialogue,
    cards,
  };
}

function parseStrictJson(raw) {
  if (!raw) return null;
  // 兜底：万一模型多包了文本，抓取首个 {...}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const clampScore = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  };

  // 先试标准解析；失败则走容错解析（模型常在 note 里嵌未转义的英文引号，破坏 JSON）。
  let obj = null;
  try {
    obj = JSON.parse(match[0]);
  } catch (_) {
    obj = lenientParse(match[0]);
  }
  if (!obj) return null;

  const s = obj.scores || {};
  const tones = Array.isArray(obj.tones)
    ? obj.tones
        .filter((t) => t && typeof t.label === "string" && typeof t.text === "string")
        .slice(0, 4)
        .map((t) => ({ label: t.label, text: t.text }))
    : [];
  // chunks：可复用表达块数组。兼容老格式（construct 字符串）——若没有 chunks 但有 construct，
  // 把它当成一个 skeleton chunk。
  let chunks = [];
  if (Array.isArray(obj.chunks)) {
    chunks = obj.chunks
      .filter((c) => c && typeof c.text === "string" && c.text.trim())
      .slice(0, 6)
      .map((c) => ({
        text: c.text,
        type: ["fixed", "skeleton", "semi"].includes(c.type) ? c.type : "skeleton",
        label: typeof c.label === "string" ? c.label : "",
        isUpgrade: c.isUpgrade === true || c.isUpgrade === "true",
      }));
  } else if (typeof obj.construct === "string" && obj.construct.trim()) {
    chunks = [{ text: obj.construct, type: "skeleton", label: "", isUpgrade: false }];
  }
  return {
    natural: obj.natural === true || obj.natural === "true",
    intent: typeof obj.intent === "string" ? obj.intent : "",
    situation: typeof obj.situation === "string" ? obj.situation : "",
    situations: Array.isArray(obj.situations)
      ? obj.situations.filter((s) => typeof s === "string" && s.trim()).slice(0, 3)
      : [],
    better: typeof obj.better === "string" ? obj.better : "",
    chunks,
    note: typeof obj.note === "string" ? obj.note : "",
    impression: typeof obj.impression === "string" ? obj.impression : "",
    scores: {
      grammar: clampScore(s.grammar),
      idiomatic: clampScore(s.idiomatic),
      fitness: clampScore(s.fitness),
    },
    tones,
  };
}

// 容错解析：当模型返回的 JSON 因内部未转义引号等问题无法标准解析时，
// 逐字段用正则抠值，尽量救回可用结果。字符串值取「该键冒号后到下一个键名(或结尾)之间」的内容。
function lenientParse(text) {
  const out = {};
  // 字符串型字段：用下一个 "key": 出现处作为右边界，容忍值内部的裸引号。
  // 注：chunks 是结构化数组，正则难可靠抠取，容错路径下放弃 chunks（留空），
  // 优先救回 better/note 等关键字段；chunks 缺失不影响主结果可用。
  const strKeys = ["intent", "situation", "better", "note", "impression"];
  const nextKey = '(?:"(?:natural|intent|situation|situations|better|chunks|note|impression|scores|tones)"\\s*:|\\}\\s*$)';
  for (const k of strKeys) {
    const re = new RegExp(`"${k}"\\s*:\\s*"([\\s\\S]*?)"\\s*,?\\s*(?=${nextKey})`);
    const m = text.match(re);
    if (m) out[k] = m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  // natural
  const nat = text.match(/"natural"\s*:\s*(true|false)/);
  if (nat) out.natural = nat[1] === "true";
  // scores
  const sc = {};
  for (const sk of ["grammar", "idiomatic", "fitness"]) {
    const m = text.match(new RegExp(`"${sk}"\\s*:\\s*(\\d+)`));
    if (m) sc[sk] = Number(m[1]);
  }
  out.scores = sc;
  // tones：每个 { "label":"..","text":".." }
  const tones = [];
  const toneRe = /\{\s*"label"\s*:\s*"([\s\S]*?)"\s*,\s*"text"\s*:\s*"([\s\S]*?)"\s*\}/g;
  let tm;
  while ((tm = toneRe.exec(text)) !== null) {
    tones.push({ label: tm[1], text: tm[2].replace(/\\"/g, '"') });
  }
  out.tones = tones;
  // 至少救到 better 才算有效
  return out.better ? out : null;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

// 静态文件托管：只放行白名单文件（手机经浏览器访问各页面用），
// 避免暴露 .env、tutor-server.mjs 等敏感文件。
const STATIC_FILES = {
  "/": "text/html; charset=utf-8", // 根路径 → polish 主功能页（手机首页）
  "/polish.html": "text/html; charset=utf-8",
  "/popup.js": "application/javascript; charset=utf-8",
  "/scene.html": "text/html; charset=utf-8",
  "/scene.js": "application/javascript; charset=utf-8",
  "/chat.html": "text/html; charset=utf-8",
  "/chat.js": "application/javascript; charset=utf-8",
  "/collection.html": "text/html; charset=utf-8",
  "/collection.js": "application/javascript; charset=utf-8",
  "/quiz.html": "text/html; charset=utf-8",
  "/quiz.js": "application/javascript; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/manifest.webmanifest": "application/manifest+json; charset=utf-8",
  "/icons/icon16.png": "image/png",
  "/icons/icon32.png": "image/png",
  "/icons/icon48.png": "image/png",
  "/icons/icon128.png": "image/png",
};
function serveStatic(res, url) {
  const type = STATIC_FILES[url];
  if (!type) return false;
  // 根路径映射到 polish.html。
  const fileName = url === "/" ? "polish.html" : url.replace(/^\//, "");
  try {
    const data = fs.readFileSync(path.join(STATIC_DIR, fileName));
    res.writeHead(200, {
      "Content-Type": type,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (_) {
        resolve({});
      }
    });
  });
}

// ---- 路由 ----
async function handlePolish(req, res) {
  const { text, scene, tone, strictness } = await readBody(req);
  const input = (text || "").trim();
  if (!input) {
    sendJson(res, 400, { error: "请输入需要润色的句子。" });
    return;
  }
  // 把句子、场景、目标语气、严格度一起作为 JSON 喂给模型。
  // strictness 控制教练人格与评分松紧：'strict'（默认）/ 'easy'。
  const payload = JSON.stringify({
    sentence: input,
    scene: (scene || "").trim(),
    tone: (tone || "").trim(),
    strictness: strictness === "easy" ? "easy" : "strict",
  });
  const modelOutput = await callClaude(payload);
  const parsed = parseStrictJson(modelOutput);
  if (!parsed) {
    // 解析失败时打出模型原始返回，便于定位（构式/槽位里的方括号是否破坏了 JSON 等）。
    console.error("解析失败，模型原始返回：\n", modelOutput);
    sendJson(res, 502, { error: "模型返回格式异常" });
    return;
  }
  sendJson(res, 200, parsed);
}

// 场景预演：输入一个未来场景，返回剧本 + 抽卡。
async function handleScene(req, res) {
  const { scene } = await readBody(req);
  const input = (scene || "").trim();
  if (!input) {
    sendJson(res, 400, { error: "请输入一个你接下来要面对的场景。" });
    return;
  }
  const payload = JSON.stringify({ scene: input });
  const modelOutput = await callSceneClaude(payload);
  const parsed = parseSceneJson(modelOutput);
  if (!parsed) {
    console.error("场景解析失败，模型原始返回：\n", modelOutput);
    sendJson(res, 502, { error: "模型返回格式异常" });
    return;
  }
  sendJson(res, 200, parsed);
}

// 单句抽卡：给剧本里的一句话，现场抽成一张可收藏的卡。
async function handleExtract(req, res) {
  const { scene, speaker, text } = await readBody(req);
  const line = (text || "").trim();
  if (!line) {
    sendJson(res, 400, { error: "缺少要收藏的句子。" });
    return;
  }
  const payload = JSON.stringify({
    scene: (scene || "").trim(),
    speaker: (speaker || "").trim(),
    text: line,
  });
  const modelOutput = await callExtractClaude(payload);
  const parsed = parseCardJson(modelOutput);
  if (!parsed) {
    console.error("抽卡解析失败，模型原始返回：\n", modelOutput);
    sendJson(res, 502, { error: "模型返回格式异常" });
    return;
  }
  sendJson(res, 200, parsed);
}

// 对练：扮演对方接话 + 对用户上一句轻反馈。无状态多轮，请求带场景、剧本、history 和角色分配。
async function handleChat(req, res) {
  const { scene, script, history, learnerRole, aiRole } = await readBody(req);
  const scr = Array.isArray(script)
    ? script
        .filter((s) => s && typeof s.text === "string")
        .map((s) => ({ speaker: typeof s.speaker === "string" ? s.speaker : "", text: s.text }))
    : [];
  const hist = Array.isArray(history)
    ? history
        .filter((h) => h && typeof h.text === "string" && (h.role === "me" || h.role === "them"))
        .map((h) => ({ role: h.role, text: h.text }))
    : [];
  const payload = JSON.stringify({
    scene: (scene || "").trim(),
    script: scr,
    history: hist,
    // 角色分配：默认学员演「你」、AI 演「对方」；互换时由前端传入对调后的角色标签。
    learnerRole: (learnerRole || "你").trim() || "你",
    aiRole: (aiRole || "对方").trim() || "对方",
  });
  const modelOutput = await callChatClaude(payload);
  const parsed = parseChatJson(modelOutput);
  if (!parsed) {
    console.error("对练解析失败，模型原始返回：\n", modelOutput);
    sendJson(res, 502, { error: "模型返回格式异常" });
    return;
  }
  sendJson(res, 200, parsed);
}

// 复习判定：判断学员回答是否命中目标意图（复述/泛化两模式）。
async function handleJudge(req, res) {
  const { intent, accepted, yours, mode } = await readBody(req);
  const answer = (yours || "").trim();
  if (!answer) {
    sendJson(res, 400, { error: "请输入你的英文回答。" });
    return;
  }
  const acc = Array.isArray(accepted)
    ? accepted.filter((a) => typeof a === "string" && a.trim()).slice(0, 6)
    : [];
  const payload = JSON.stringify({
    intent: (intent || "").trim(),
    accepted: acc,
    yours: answer,
    mode: mode === "transfer" ? "transfer" : "replay",
  });
  const modelOutput = await callJudgeClaude(payload);
  const parsed = parseJudgeJson(modelOutput);
  if (!parsed) {
    console.error("判定解析失败，模型原始返回：\n", modelOutput);
    sendJson(res, 502, { error: "模型返回格式异常" });
    return;
  }
  sendJson(res, 200, parsed);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  const url = (req.url || "").split("?")[0];
  try {
    // GET 静态页：手机 Safari 直接访问的各页面（scene/chat/polish 等）
    if (req.method === "GET" && serveStatic(res, url)) return;
    // 模型接口统一鉴权：设了访问口令时，POST 接口必须带正确的 x-tutor-key，否则 401。
    // 静态页不校验（让手机能先打开页面，页面再带 key 请求接口）。
    if (req.method === "POST" && ACCESS_KEY) {
      const provided = req.headers["x-tutor-key"] || "";
      if (provided !== ACCESS_KEY) {
        sendJson(res, 401, { error: "访问口令无效" });
        return;
      }
    }
    if (req.method === "POST" && url === "/polish") return await handlePolish(req, res);
    if (req.method === "POST" && url === "/scene") return await handleScene(req, res);
    if (req.method === "POST" && url === "/extract") return await handleExtract(req, res);
    if (req.method === "POST" && url === "/chat") return await handleChat(req, res);
    if (req.method === "POST" && url === "/judge") return await handleJudge(req, res);
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 500, { error: String(error?.message || error) });
  }
});

// 找出本机局域网 IPv4，方便打印手机可访问的地址。
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log(`服务监听 ${HOST}:${PORT}`);
  console.log(`本机访问: http://127.0.0.1:${PORT}/scene.html`);
  const lans = lanAddresses();
  if (HOST !== "127.0.0.1" && lans.length) {
    console.log("同一 WiFi 下的 iPhone 可访问（任选其一）:");
    for (const ip of lans) console.log(`  http://${ip}:${PORT}/scene.html`);
  }
  // 无状态直连，无需预热会话；prompt caching 会在第一次真实请求后自动生效。
});
