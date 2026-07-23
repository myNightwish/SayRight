// extract-sentences.mjs
// 从一段 Ducc / Claude Code 对话记录（.jsonl）里提取英文句子，
// 组织成「划词释义收藏」插件支持导入的 JSON 格式（全部 kind="sentence"）。
//
// 两类来源都会抽取：
//   1. 你自己写的英文练习句  —— user 消息里的英文文本
//   2. tutor 给出的更地道说法 —— assistant 文本里 {"natural":...,"better":...} 的 better
//
// 设计成「指定对话 → 先预览 → 再导入」：本工具只负责生成草稿 JSON，
// 你看一眼候选、删掉不想要的，再去收藏页点「导入」。不直接写插件存储。
//
// 用法：
//   node extract-sentences.mjs <对话.jsonl> [输出.json]
//   node extract-sentences.mjs                # 不带参数：列出最近的对话文件供选择
//   node extract-sentences.mjs <对话.jsonl> --patterns
//       实验模式：用模型从对话里抽「Reflection Patterns」——可复用的思维/句式模板
//       （如 "It wasn't really about {X}. It was about {Y}."），而非具体句子。
//       素材只取 tutor 的 better（AI 的地道改写），不取用户原话。
//       只打印预览供评估，默认不写文件；加 [输出.json] 才落盘（kind="pattern"）。
//
// 对话文件默认位置：~/.claude/projects/-Users-maomao-Desktop-see/*.jsonl
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT_DIR = path.join(
  os.homedir(),
  ".claude",
  "projects",
  "-Users-maomao-Desktop-see"
);

// 取一条记录里的纯文本（content 可能是字符串或 block 数组）。
// {"natural":bool,"better":"...","note":"..."} 这样的 JSON（润色返回）。
function extractBetters(text) {
  const out = [];
  // 逐个匹配带 "better" 键的 JSON 对象
  const re = /\{[^{}]*"better"[^{}]*\}/g;
  const matches = text.match(re) || [];
  for (const m of matches) {
    try {
      const obj = JSON.parse(m);
      const better = (obj.better || "").trim();
      if (better) out.push(better);
    } catch (_) { /* 不是合法 JSON 片段，跳过 */ }
  }
  return out;
}

// 把句子里的换行/多余空白压成单个空格，收藏显示更整齐。
function collapseWhitespace(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

// 解析一个对话文件，返回 { mine: Set, betters: Set }。
function extractFromFile(file) {
  const mine = new Map();    // text -> savedAt(首次出现时间)
  const betters = new Map();
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch (_) { continue; }
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (o.isMeta) continue;
    const msg = o.message || {};
    const text = blocksToText(msg.content);
    const ts = o.timestamp ? Date.parse(o.timestamp) || Date.now() : Date.now();

    if (o.type === "user") {
      if (isEnglishPracticeSentence(text)) {
        const clean = collapseWhitespace(text);
        if (!mine.has(clean)) mine.set(clean, ts);
      }
    } else {
      for (const b of extractBetters(text)) {
        const clean = collapseWhitespace(b);
        if (clean && !betters.has(clean)) betters.set(clean, ts);
      }
    }
  }
  return { mine, betters };
}

// 列出最近的对话文件（按修改时间倒序），方便不带参数时挑选。
function listRecentConversations(n = 15) {
  let files;
  try {
    files = fs.readdirSync(PROJECT_DIR);
  } catch (_) {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"))
    .map((f) => {
      const full = path.join(PROJECT_DIR, f);
      return { file: full, name: f, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n);
}

// 取一条记录里的纯文本（content 可能是字符串或 block 数组）。
function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

// 判断一段文本是否「值得作为英文练习句收藏」。
// 过滤掉：空白、斜杠命令、<xml 包裹的系统注入>、中断提示、
// 中文为主、英文单词太少（碎词）的内容。
function isEnglishPracticeSentence(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.startsWith("/")) return false;               // /model 这类命令
  if (t.startsWith("<")) return false;                // <command-name> / <local-command-...> 等注入
  if (/^\[Request interrupted/.test(t)) return false; // 中断提示
  const enWords = t.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  if (enWords.length < 3) return false;               // 至少几个英文词，否则算碎词
  const zh = (t.match(/[一-鿿]/g) || []).length;
  const en = (t.match(/[A-Za-z]/g) || []).length;
  if (zh > en) return false;                          // 中文为主，判为中文消息
  return true;
}

// --- CLI ---
function printUsage() {
  const recents = listRecentConversations();
  console.log("用法: node extract-sentences.mjs <对话.jsonl> [输出.json]");
  console.log("      node extract-sentences.mjs <对话.jsonl> --patterns   # 实验：抽思维模板\n");
  if (recents.length) {
    console.log("最近的对话文件（复制路径作为第一个参数）：");
    for (const r of recents) {
      const when = new Date(r.mtime).toLocaleString("zh-CN");
      console.log(`  ${when}  ${r.file}`);
    }
  } else {
    console.log(`未在 ${PROJECT_DIR} 找到对话文件。`);
  }
}

// 把对话里的素材拼成给模型看的语料。
// Reflection Pattern 只从 tutor 的 better 里抽——那是 AI 产出的地道改写，
// 质量高、且是对话式反思性英文；用户自己的原话（mine）质量参差，不作为素材。
function buildCorpus(inputFile) {
  const { betters } = extractFromFile(inputFile);
  return [...betters.keys()].join("\n");
}

// 实验模式：调用本地 tutor-server 之外，直接用 Claude Agent SDK 抽 Reflection Patterns。
// 抽不出来或没装 SDK 时，给出明确提示，不影响主流程。
async function extractPatterns(inputFile, outputArg) {
  let query;
  try {
    ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
  } catch (_) {
    console.error("未找到 @anthropic-ai/claude-agent-sdk，无法运行 --patterns 实验模式。");
    console.error("先在仓库目录执行: npm install @anthropic-ai/claude-agent-sdk");
    process.exit(1);
  }

  const corpus = buildCorpus(inputFile);
  if (!corpus.trim()) {
    console.error("这段对话里没抽到 tutor 的 better 改写（Reflection Pattern 只从 AI 改写里抽），换一个对话试试。");
    process.exit(1);
  }

  const SYSTEM_PROMPT = [
    "You analyze a learner's English sentences and extract REUSABLE REFLECTION PATTERNS.",
    "A pattern is NOT a specific sentence and NOT a vocabulary word.",
    "It is a reusable thinking/sentence frame with slots, e.g.:",
    '  "Looking back, I realize that {X}."',
    '  "It wasn\'t really about {X}. It was about {Y}."',
    '  "The more I {X}, the more I realize {Y}."',
    "Abstract recurring rhetorical/metacognitive frames; replace the variable parts with {X}, {Y}.",
    "Prefer frames that recur or that carry a transferable way of thinking.",
    "",
    "OUTPUT FORMAT — follow EXACTLY:",
    "- Output ONLY a single minified JSON array, no markdown, no prose.",
    "- Each element: {\"pattern\": string, \"example\": string, \"note\": string}",
    '  "pattern": the frame with {X}/{Y} slots.',
    '  "example": one concrete sentence from the input that fits this frame.',
    '  "note": Simplified Chinese, one short line on when to use this frame.',
    "- Return at most 8 patterns. If none are worth keeping, return [].",
  ].join("\n");

  console.log("正在用模型抽取 Reflection Patterns…（首次约 10s）\n");
  const q = query({
    prompt: `${SYSTEM_PROMPT}\n\nLearner sentences:\n${corpus}`,
    options: { permissionMode: "bypassPermissions", maxTurns: 1 },
  });

  let raw = "";
  for await (const message of q) {
    if (message.type === "result" && message.result) raw = message.result;
  }

  let patterns = [];
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try { patterns = JSON.parse(match[0]); } catch (_) { /* 见下方兜底 */ }
  }
  if (!Array.isArray(patterns) || !patterns.length) {
    console.error("模型没有抽出可用的 pattern（或返回格式异常）。原始输出：");
    console.error(raw.slice(0, 500));
    process.exit(1);
  }

  console.log(`=== Reflection Patterns（${patterns.length}）===`);
  patterns.forEach((p, i) => {
    console.log(`\n  ${i + 1}. ${p.pattern}`);
    if (p.example) console.log(`     例: ${p.example}`);
    if (p.note) console.log(`     ${p.note}`);
  });

  // 默认只预览不落盘；给了输出路径才写成插件可导入格式（kind="pattern"）。
  if (outputArg) {
    const items = patterns
      .filter((p) => p && p.pattern)
      .map((p) => ({ kind: "pattern", text: collapseWhitespace(p.pattern), savedAt: Date.now() }));
    fs.writeFileSync(outputArg, JSON.stringify(items, null, 2));
    console.log(`\n已写入 ${items.length} 条 pattern: ${outputArg}`);
    console.log("注意：收藏页目前还不认 kind=\"pattern\"，这是为未来分类预留的实验产物。");
  } else {
    console.log("\n（实验模式默认不写文件。满意的话，加一个输出路径即可落盘。）");
  }
}

function main() {
  const [, , inputArg, ...rest] = process.argv;
  if (!inputArg) {
    printUsage();
    process.exit(0);
  }
  if (!fs.existsSync(inputArg)) {
    console.error(`找不到文件: ${inputArg}`);
    process.exit(1);
  }

  // --patterns 实验模式：抽思维模板（异步），与默认句子提取互斥。
  const wantPatterns = rest.includes("--patterns");
  const outputArg = rest.find((a) => !a.startsWith("--"));
  if (wantPatterns) {
    return extractPatterns(inputArg, outputArg);
  }

  const { mine, betters } = extractFromFile(inputArg);

  // 组织成插件导入格式：全部 kind="sentence"。同文本去重（练习句优先于 better）。
  const seen = new Set();
  const items = [];
  for (const [text, savedAt] of mine) {
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: "sentence", text, source: "mine", savedAt });
  }
  for (const [text, savedAt] of betters) {
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: "sentence", text, source: "better", savedAt });
  }

  // 预览：分两组打印，方便你删掉不想要的
  const mineItems = items.filter((it) => it.source === "mine");
  const betterItems = items.filter((it) => it.source === "better");
  console.log(`\n=== 我写的英文练习句（${mineItems.length}）===`);
  mineItems.forEach((it, i) => console.log(`  ${i + 1}. ${it.text}`));
  console.log(`\n=== tutor 的更地道说法 better（${betterItems.length}）===`);
  betterItems.forEach((it, i) => console.log(`  ${i + 1}. ${it.text}`));

  // 写出导入用 JSON。source 字段只是给你预览参考，导入时收藏页会忽略多余字段。
  const outPath = outputArg || path.join(process.cwd(), "import-sentences.json");
  fs.writeFileSync(outPath, JSON.stringify(items, null, 2));
  console.log(`\n共 ${items.length} 条，已写入: ${outPath}`);
  console.log("检查无误后，去收藏页点「导入」选择该文件即可（重复会自动跳过）。");
}

main();


