// Pure capture rules shared by the extension worker, preview and tests.
(function () {
  const root = typeof window === 'undefined' ? globalThis : window;
  function cleanUrl(value) {
    try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.origin + u.pathname : ''; } catch (_) { return ''; }
  }
  function validate(raw, text) {
    if (!raw || typeof raw !== 'object') return null;
    const fields = ['personalContext', 'practiceCue', 'transferCue'];
    if (fields.some(k => typeof raw[k] !== 'string' || !raw[k].trim() || raw[k].length > 700)) return null;
    // Prompts must not give away the selected answer. Invalid output is never auto-saved.
    const target = text.trim().toLowerCase().replace(/[.!?]+$/, '');
    if (target && ['practiceCue', 'transferCue'].some(k => raw[k].toLowerCase().includes(target))) return null;
    return Object.fromEntries(fields.map(k => [k, raw[k].trim()]));
  }
  function captureInto(map, selection, generated, now) {
    const key = root.NuanceLearning.keyOf(selection.text);
    if (!key || key === '__proto__' || key.length > 1200) throw new Error('请选择 2～1200 个字符的表达');
    const previous = Object.hasOwn(map, key) ? map[key] : null;
    const active = root.NuanceLearning.canActivate(map, previous || {studyState:'inbox'});
    const item = previous ? { ...previous } : {
      input: selection.text.trim(), better: selection.text.trim(), origin: 'web-selection', stars: 0,
      createdAt: now, sourceLabel: String(selection.title || '').slice(0,160), sourceUrl: cleanUrl(selection.url),
    };
    // Duplicates retain the user's prompt, notes and schedule. Archived items can be reactivated by this explicit action.
    item.captureId ||= root.crypto?.randomUUID?.() || `capture-${now}-${Math.random().toString(36).slice(2)}`;
    if (!item.situation) item.situation = generated.practiceCue;
    if (!item.personalContext) item.personalContext = generated.personalContext;
    if (!Array.isArray(item.situations) || !item.situations.length) item.situations = [generated.transferCue];
    const nextState=active?'active':'inbox';
    if(!previous||root.NuanceLearning.stateOf(previous)!==nextState){item.queueChangedAt=now;item.queueJoinedAt=active?now:item.queueJoinedAt;item.queueRoundId=null;}
    item.studyState = nextState;
    item.createdAt ||= previous?.savedAt || now;
    item.savedAt = now;
    const result = { ...map };
    Object.defineProperty(result,key,{value:item,enumerable:true,writable:true,configurable:true});
    return {map:result,key,item,existed:Boolean(previous),active};
  }
  function mergeState(server, fresh) {
    const corrections = {...server.corrections};
    for (const [key,item] of Object.entries(fresh.corrections || {})) {
      if (key === '__proto__') continue;
      corrections[key]=root.NuanceLearning.mergeVersions(corrections[key],item);
    }
    const tombstones={...server.tombstones};
    for (const [key,time] of Object.entries(fresh.tombstones || {})) tombstones[key]=Math.max(tombstones[key]||0,time);
    for (const [key,time] of Object.entries(tombstones)) if(corrections[key] && (corrections[key].savedAt||0)<=time) delete corrections[key];
    return {corrections,tombstones};
  }
  root.NuanceCapture = {cleanUrl,validate,captureInto,mergeState};
})();
