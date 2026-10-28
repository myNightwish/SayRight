// Shared learning rules. Existing records are interpreted without rewriting them.
(function () {
  const ACTIVE_LIMIT = 10;
  function stateOf(item) {
    if (['inbox', 'active', 'archived'].includes(item.studyState)) return item.studyState;
    return (item.stars > 0 || item.starred) ? 'active' : 'inbox';
  }
  function keyOf(text) { return String(text || '').trim().toLowerCase(); }
  function parse(text) {
    const seen = new Set();
    return String(text).split(/\r?\n/).map(line => {
      const parts = line.split('｜');
      const expression = parts.shift().replace(/^\s*(?:[-*•]|\d+[.)、])\s+/, '').trim();
      return { expression, cue: parts.join('｜').trim() };
    }).filter(row => {
      const key = keyOf(row.expression);
      if (!key || key === "__proto__" || seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  function create(row, source, now) {
    return { input: row.expression, better: row.expression, situation: row.cue,
      sourceLabel: source.trim(), origin: 'direct', studyState: 'inbox',
      situations: [], chunks: [], stars: 0, createdAt: now, savedAt: now };
  }
  // Marking learning material is unlimited; admission to the pinned window is capped in queue-core.js.
  function canActivate() { return true; }
  // Learning state has its own version: a newer note/star must not undo an archive on another device.
  function mergeVersions(a,b){
    if(!a)return b;if(!b)return a;
    const latest=(b.savedAt||0)>=(a.savedAt||0)?b:a;
    const queue=(b.queueChangedAt||0)>(a.queueChangedAt||0)?b:a;
    const merged=queue.queueChangedAt?{...latest,studyState:queue.studyState,queueChangedAt:queue.queueChangedAt,queueJoinedAt:queue.queueJoinedAt,queueRoundId:queue.queueRoundId}:latest;
    const expression=(b.expressionChangedAt||0)>(a.expressionChangedAt||0)?b:a;
    return expression.expressionChangedAt?{...merged,better:expression.better,originalBetter:expression.originalBetter,adoptedAttemptId:expression.adoptedAttemptId,expressionChangedAt:expression.expressionChangedAt}:merged;
  }
  function addRows(map, rows, source, now) {
    const result = { ...map }; let added = 0;
    for (const row of rows) {
      const key = keyOf(row.expression);
      if (!key || key === '__proto__' || Object.hasOwn(result, key)) continue;
      Object.defineProperty(result, key, { value: create(row, source, now), enumerable: true, configurable: true, writable: true });
      added++;
    }
    return { map: result, added };
  }
  (typeof window === "undefined" ? globalThis : window).NuanceLearning = { ACTIVE_LIMIT, stateOf, keyOf, parse, create, canActivate, addRows, mergeVersions };
})();
