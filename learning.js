// Shared learning rules. Existing records are interpreted without rewriting them.
(function () {
  const ACTIVE_LIMIT = 20;
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
  function canActivate(map, item) {
    return stateOf(item) === 'active' || Object.values(map).filter(it => stateOf(it) === 'active').length < ACTIVE_LIMIT;
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
  (typeof window === "undefined" ? globalThis : window).NuanceLearning = { ACTIVE_LIMIT, stateOf, keyOf, parse, create, canActivate, addRows };
})();
