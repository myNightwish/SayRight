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
  const KEYS = ["corrections", "sceneSaves", "sceneScripts", "drillState"];
  const TOMB_KEY = "syncTombstones";
  const LS_ACCESS = "tutorAccessKey";

  const hasChromeStorage =
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  // 所有客户端共用线上同步环境；模型请求仍可使用本地服务。
  const ORIGIN = window.NUANCE_REMOTE_ORIGIN || location.origin;
  const SYNC_ENDPOINT = `${ORIGIN}/sync`;

  function getKey() {
    try { return localStorage.getItem(LS_ACCESS) || ""; } catch (_) { return ""; }
  }

  // ---- 本地存储读写（chrome.storage 优先，localStorage 兜底）----
  function getLocal(key) {
    return new Promise((resolve, reject) => {
      if (hasChromeStorage) {
        chrome.storage.local.get(key, (res) => {
          if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res[key] || {});
        });
      } else {
        try { resolve(JSON.parse(localStorage.getItem(key) || "{}")); }
        catch (error) { reject(error); }
      }
    });
  }
  function setLocal(key, val) {
    if (hasChromeStorage) return new Promise((resolve, reject) => chrome.storage.local.set({ [key]: val }, () => {
      if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    }));
    localStorage.setItem(key, JSON.stringify(val));
    return Promise.resolve();
  }

  async function readAll() {
    const [corrections, sceneSaves, sceneScripts, drillState, tombstones] = await Promise.all([
      getLocal("corrections"), getLocal("sceneSaves"),
      getLocal("sceneScripts"), getLocal("drillState"), getLocal(TOMB_KEY),
    ]);
    return { corrections, sceneSaves, sceneScripts, drillState, tombstones };
  }

  // 用返回的墓碑清掉本地被别端删除的项（墓碑时间 >= 本地 savedAt 才删）。
  function applyTombstones(map, tombstones) {
    for (const [k, at] of Object.entries(tombstones || {})) {
      const item = map[k];
      if (item && (item.savedAt || 0) <= at) delete map[k];
    }
  }

  // 客户端侧并集合并（与服务端 mergeMap 同款 savedAt-wins）。
  // 写回时用它把「服务端合并结果」再和「当前最新本地态」并一次——
  // 关键：同步是异步的，一趟慢同步飞行期间用户可能又收藏了新条目（写进本地）。
  // 若直接 setLocal(服务端结果) 就会把这些新条目盲覆盖掉（就是「收藏丢失」的根因）。
  // 重新读一次本地、按 savedAt-wins 合并，飞行期间的新增/新改一定保住。
  function mergeMapLocal(base, incoming) {
    const out = { ...(base || {}) };
    for (const [k, v] of Object.entries(incoming || {})) {
      if (!v || typeof v !== "object") continue;
      const cur = out[k];
      out[k]=window.NuanceLearning?.mergeVersions(cur,v)||(!cur||(v.savedAt||0)>=(cur.savedAt||0)?v:cur);
    }
    return out;
  }

  let inFlight = null;
  let lastSynced = null;
  let debounceTimer = null;
  const fingerprint = (value) => JSON.stringify(value);

  // 每次先比较完整本地快照。并发调用共享同一轮；只有新改动才补传。
  function syncNow() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (inFlight) return inFlight;
    inFlight = runSync().catch((error) => {
      console.warn("[sync] 同步失败，本地数据保留:", error.message);
      try { window.dispatchEvent(new CustomEvent("nuance:sync-error", { detail: error.message })); } catch (_) {}
      return false;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function runSync() {
    while (true) {
      const local = await readAll();
      if (fingerprint(local) === lastSynced) return true;
      // 保留迁移前原始版本，包括被较新删除记录遮盖的收藏。
      const backupKey = "nuanceSyncBackup:" + SYNC_ENDPOINT;
      if (!localStorage.getItem(backupKey)) {
        localStorage.setItem(backupKey, JSON.stringify({ at: Date.now(), state: local }));
      }
      const headers = { "Content-Type": "application/json" };
      const key = getKey();
      if (key) headers["x-tutor-key"] = key;
      const res = await fetch(SYNC_ENDPOINT, {
        method: "POST", headers, body: JSON.stringify(local),
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const merged = await res.json();
      if (!merged || KEYS.some((key) => !merged[key] || typeof merged[key] !== "object") ||
          !merged.tombstones || typeof merged.tombstones !== "object") {
        throw new Error("同步响应不完整，已停止写回");
      }
      // 关键防丢：同步是异步的，这趟请求飞行期间用户可能又收藏/改了新条目（已落本地）。
      // 服务端只见到我们上行时的旧快照，回传里没有这些新条目。若直接写回服务端结果就把它们冲掉了。
      // 所以：写回前重新读一次「当前最新本地态」，再与服务端结果按 savedAt-wins 并一次——
      // 新收藏（savedAt 更新）胜出得以保留，别端的更新也照常合并进来。
      const fresh = await readAll();

      const corrections = mergeMapLocal(merged.corrections || {}, fresh.corrections);
      const sceneSaves = mergeMapLocal(merged.sceneSaves || {}, fresh.sceneSaves);
      // 远端与最新本地的剧本、复习进度也按版本合并。
      const sceneScripts = mergeMapLocal(
        merged.sceneScripts && typeof merged.sceneScripts === "object" ? merged.sceneScripts : {},
        fresh.sceneScripts
      );
      const drillState = mergeMapLocal(
        merged.drillState && typeof merged.drillState === "object" ? merged.drillState : {},
        fresh.drillState
      );
      // 墓碑同理：本地飞行期间新记的删除也要并进来，别被服务端旧墓碑覆盖。
      const tombstones = { ...(merged.tombstones || {}) };
      for (const [k, at] of Object.entries(fresh.tombstones || {})) {
        if (!tombstones[k] || at > tombstones[k]) tombstones[k] = at;
      }
      // 服务端已并集+抹除，这里再保险地本地也应用一次墓碑。
      applyTombstones(corrections, tombstones);
      applyTombstones(sceneSaves, tombstones);
      const scriptCutoff = tombstones["__sceneScriptsClearedBefore"] || 0;
      if (scriptCutoff) for (const [key, item] of Object.entries(sceneScripts)) {
        if ((item.savedAt || 0) <= scriptCutoff) delete sceneScripts[key];
      }

      await Promise.all([
        setLocal("corrections", corrections),
        setLocal("sceneSaves", sceneSaves),
        setLocal("sceneScripts", sceneScripts),
        setLocal("drillState", drillState),
        setLocal(TOMB_KEY, tombstones),
      ]);
      const combined = { corrections, sceneSaves, sceneScripts, drillState, tombstones };
      // fresh 和上行快照不同，说明飞行期间产生了新改动，必须再传一轮。
      const changedDuringRequest = fingerprint(fresh) !== fingerprint(local);
      lastSynced = changedDuringRequest ? null : fingerprint(combined);
      try { window.dispatchEvent(new CustomEvent("nuance:synced")); } catch (_) {}
      if (!changedDuringRequest) return true;
    }
  }

  // 记一条删除墓碑（各页删除收藏时调用），随后触发上行。
  async function recordDelete(mapKey) {
    if (!mapKey) return;
    const tomb = await getLocal(TOMB_KEY);
    tomb[mapKey] = Date.now();
    await setLocal(TOMB_KEY, tomb);
    syncNow();
  }

  // 批量记墓碑：一次读-改-写，避免多次并发 recordDelete 互相覆盖导致漏记（漏记的会被别端旧数据复活）。
  async function recordDeleteMany(mapKeys) {
    const list = (mapKeys || []).filter(Boolean);
    if (!list.length) return;
    const tomb = await getLocal(TOMB_KEY);
    const now = Date.now();
    for (const k of list) tomb[k] = now;
    await setLocal(TOMB_KEY, tomb);
    return syncNow();
  }

  // 去抖上行：高频本地小改动（打星、抽卡进度、下一题、对练命中）不必每次都立刻打网络，
  // 攒到安静 DEBOUNCE_MS 再合并成一趟。改动已先落地本地，晚几秒上行不丢；
  // 关页/切后台尽力补传；浏览器中止请求时，下次打开重试。
  const DEBOUNCE_MS = 1500;
  function syncSoon() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = null; syncNow(); }, DEBOUNCE_MS);
  }
  // 取消挂起的去抖并立刻上行——关页/切后台等「必须保住」的时刻用。
  function flushSync() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    return syncNow();
  }

  // 暴露给各页脚本。syncNow=立即；syncSoon=去抖合并（高频小改动首选）。
  window.NuanceSync = { syncNow, syncSoon, recordDelete, recordDeleteMany };

  // 打开即拉一次。
  syncNow();
  // 切后台 / 关页时补一次上行（flush 掉去抖里攒着的改动），尽量不丢刚产生的改动。
  window.addEventListener("pagehide", () => { flushSync(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSync();
  });
})();
