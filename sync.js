// sync.js —— 收藏云同步（多设备「结合」而非替代/累加）。必须在各页脚本之前、auth.js 之后加载。
//
// 三类本地数据都存在 chrome.storage.local / localStorage：
//   corrections（润色收藏）、sceneSaves（场景收藏）、sceneScripts（场景剧本）。
// 另加一个 syncTombstones（删除墓碑：key -> deletedAt 毫秒）。
//
// 工作方式：
//   1) 打开页面(load) → syncNow()：把本地三类 + 墓碑 上行 /sync，服务端并集合并后回传，写回本地。
//   2) 用户新增/删除收藏后，或切后台/关页(pagehide/visibilitychange) → syncNow()，把改动尽快上行。
//   3) 合并遵循：同 key 取 savedAt 新者；删除靠墓碑传播（删掉的不会被别端旧数据复活）。
//   写回本地后派发 window 事件 "nuance:synced"，收藏页据此重渲染。
(function () {
  const KEYS = ["corrections", "sceneSaves", "sceneScripts"];
  const TOMB_KEY = "syncTombstones";
  const LS_ACCESS = "tutorAccessKey";

  const hasChromeStorage =
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  // 同步端点：H5 跟随 location.origin；插件(chrome-extension://)打到 config.js 的线上域名。
  const ORIGIN =
    typeof location !== "undefined" && location.protocol.startsWith("http")
      ? location.origin
      : (typeof window !== "undefined" && window.NUANCE_REMOTE_ORIGIN) || "http://127.0.0.1:8770";
  const SYNC_ENDPOINT = `${ORIGIN}/sync`;

  function getKey() {
    try { return localStorage.getItem(LS_ACCESS) || ""; } catch (_) { return ""; }
  }

  // ---- 本地存储读写（chrome.storage 优先，localStorage 兜底）----
  function getLocal(key) {
    return new Promise((resolve) => {
      if (hasChromeStorage) {
        chrome.storage.local.get(key, (res) => resolve(res[key] || {}));
      } else {
        try { resolve(JSON.parse(localStorage.getItem(key) || "{}")); }
        catch (_) { resolve({}); }
      }
    });
  }
  function setLocal(key, val) {
    if (hasChromeStorage) return new Promise((r) => chrome.storage.local.set({ [key]: val }, r));
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
    return Promise.resolve();
  }

  async function readAll() {
    const [corrections, sceneSaves, sceneScripts, tombstones] = await Promise.all([
      getLocal("corrections"), getLocal("sceneSaves"),
      getLocal("sceneScripts"), getLocal(TOMB_KEY),
    ]);
    return { corrections, sceneSaves, sceneScripts, tombstones };
  }

  // 用返回的墓碑清掉本地被别端删除的项（墓碑时间 >= 本地 savedAt 才删）。
  function applyTombstones(map, tombstones) {
    for (const [k, at] of Object.entries(tombstones || {})) {
      const item = map[k];
      if (item && (item.savedAt || 0) <= at) delete map[k];
    }
  }

  let inFlight = null;
  // 上行本地态 → 取回合并态 → 写回本地。并发调用会复用同一次请求，避免重复打接口。
  async function syncNow() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const local = await readAll();
      const headers = { "Content-Type": "application/json" };
      const key = getKey();
      if (key) headers["x-tutor-key"] = key;
      let merged;
      try {
        const res = await fetch(SYNC_ENDPOINT, {
          method: "POST", headers, body: JSON.stringify(local),
        });
        if (!res.ok) return false; // 401/网络问题：静默跳过，纯本地照常用
        merged = await res.json();
      } catch (_) {
        return false;
      }
      if (!merged || typeof merged !== "object") return false;

      const corrections = merged.corrections || {};
      const sceneSaves = merged.sceneSaves || {};
      const sceneScripts = merged.sceneScripts || {};
      const tombstones = merged.tombstones || {};
      // 服务端已并集+抹除，这里再保险地本地也应用一次墓碑。
      applyTombstones(corrections, tombstones);
      applyTombstones(sceneSaves, tombstones);

      await Promise.all([
        setLocal("corrections", corrections),
        setLocal("sceneSaves", sceneSaves),
        setLocal("sceneScripts", sceneScripts),
        setLocal(TOMB_KEY, tombstones),
      ]);
      try { window.dispatchEvent(new CustomEvent("nuance:synced")); } catch (_) {}
      return true;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }

  // 记一条删除墓碑（各页删除收藏时调用），随后触发上行。
  async function recordDelete(mapKey) {
    if (!mapKey) return;
    const tomb = await getLocal(TOMB_KEY);
    tomb[mapKey] = Date.now();
    await setLocal(TOMB_KEY, tomb);
    syncNow();
  }

  // 暴露给各页脚本。
  window.NuanceSync = { syncNow, recordDelete };

  // 打开即拉一次。
  syncNow();
  // 切后台 / 关页时补一次上行，尽量不丢刚产生的改动。
  window.addEventListener("pagehide", () => { syncNow(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") syncNow();
  });
})();
