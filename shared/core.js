/**
 * 공용 로직. 서버(Lambda)와 앱 화면이 같은 파일을 쓴다.
 *  - 등록 형식 검사와 병합: normalizePayload, mergeItem
 *  - 간격 계산: recallP, applyResult
 *  - 세션 구성: buildSession, buildQuiz
 * DOM이나 네트워크를 쓰지 않는 순수 함수만 둔다.
 */
var DAY = 864e5;
var CFG = {
  target: 7,        // 세션 1회의 항목 수
  dueP: 0.7,        // 예상 기억 확률이 이 값 아래면 복습 대상
  newMax: 2,        // 평소 신규 항목 상한
  newMaxCold: 4,    // 익히는 항목이 적을 때 신규 상한
  coldBelow: 6,
  retryMax: 3,      // 세션 끝 재출제 상한
  hMin: 0.25, hCap: 180,
  familiarH: 14,    // 반감기가 이 일수 이상이면 '익숙함'
  recentDays: 7,    // 등록(또는 학습 시작) 뒤 이 기간은 매 세션에 넣는다
  targetRecent: 10, // 최근 항목이 있을 때의 세션 항목 수
  newMaxRecent: 4,  // 최근 등록한 새 항목은 투입 조건과 무관하게 이만큼 시작
  keepDue: 2,       // 최근 항목이 많아도 오래된 복습 대상에 남겨 두는 자리
  maxCards: 16,     // 다시 풀기를 뺀 카드 수 상한
  maxPerCall: 20
};

function str(v) { return v == null ? '' : String(v).trim(); }
function arr(v) { return Array.isArray(v) ? v : []; }
function uniq(a) { var s = {}, o = []; a.forEach(function (x) { var k = String(x).toLowerCase(); if (x && !s[k]) { s[k] = 1; o.push(x); } }); return o; }
function shuffle(a, rnd) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor((rnd || Math.random)() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

/* ---------- 등록 계약 ---------- */
function normText(t) {
  return str(t).toLowerCase()
    .replace(/\b(somebody|sb)\b/g, 'someone').replace(/\bsth\b/g, 'something')
    .replace(/^to\s+/, '').replace(/[~…]/g, ' ').replace(/\s+/g, ' ').trim();
}
function slug(text) {
  var n = normText(text);
  var s = n.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (s) return s;
  var h = 0; for (var i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return 'item-' + h.toString(36);
}
function exPlain(en) { return String(en).replace(/[\[\]]/g, ''); }
function exFill(en) {
  var m = String(en).match(/\[([^\]]+)\]/g);
  return m ? m.map(function (s) { return s.slice(1, -1).trim(); }).join(' … ') : null;
}
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function autoMark(en, text) {
  if (/\[[^\]]+\]/.test(en)) return en;
  var re = new RegExp('\\b' + escRe(str(text)).replace(/\s+/g, '\\s+') + '\\b', 'i');
  return re.test(en) ? en.replace(re, function (m) { return '[' + m + ']'; }) : en;
}
function stripFence(s) {
  s = String(s).trim();
  var m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) return m[1].trim();
  var a = s.indexOf('{'), b = s.lastIndexOf('}');
  var a2 = s.indexOf('[');
  if (a2 !== -1 && (a === -1 || a2 < a)) { b = s.lastIndexOf(']'); a = a2; }
  return a !== -1 && b > a ? s.slice(a, b + 1) : s;
}
function rel(a) {
  return arr(a).map(function (x) {
    return typeof x === 'string' ? { text: str(x), note: '' } : { text: str(x && x.text), note: str(x && x.note) };
  }).filter(function (x) { return x.text; }).slice(0, 8);
}

/** add_items 입력을 검사하고 저장 형태로 바꾼다. MCP 서버가 할 일과 같은 규칙이다. */
function normalizePayload(raw, now) {
  var errors = [], warnings = [], out = [], obj = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return { items: [], errors: ['내용이 비어 있습니다.'], warnings: [] };
    try { obj = JSON.parse(stripFence(raw)); }
    catch (e) { return { items: [], errors: ['JSON으로 읽을 수 없습니다. 코드 블록 안의 내용만 붙여 넣었는지 확인하세요. (' + e.message + ')'], warnings: [] }; }
  }
  if (Array.isArray(obj)) obj = { items: obj };
  if (!obj || !Array.isArray(obj.items) || !obj.items.length)
    return { items: [], errors: ['items 배열이 없거나 비어 있습니다.'], warnings: [] };
  var src = obj.source && str(obj.source.text)
    ? { text: str(obj.source.text), ko: str(obj.source.ko), origin: str(obj.source.origin) } : null;
  var pickedAll = str(obj.picked_by).toLowerCase();
  if (obj.items.length > CFG.maxPerCall) warnings.push('한 번에 ' + CFG.maxPerCall + '개까지만 등록합니다. 나머지는 다시 보내세요.');
  obj.items.slice(0, CFG.maxPerCall).forEach(function (it, idx) {
    it = it || {};
    var text = str(it.text), meaning = str(it.meaning_ko), label = (idx + 1) + '번 항목' + (text ? ' (' + text + ')' : '');
    if (!text) { errors.push(label + ': text가 없습니다.'); return; }
    if (!meaning) { errors.push(label + ': meaning_ko가 없습니다.'); return; }
    var kind = (it.kind === 'word' || it.kind === 'phrase') ? it.kind : (/\s/.test(text) ? 'phrase' : 'word');
  var own = it.source || it.src; // 항목마다 원문이 다르면 항목 쪽 값을 쓴다
  var isrc = own && str(own.text) ? { text: str(own.text), ko: str(own.ko), origin: str(own.origin) } : src;
    var examples = arr(it.examples).map(function (e) {
      return typeof e === 'string' ? { en: str(e), ko: '' } : { en: str(e && e.en), ko: str(e && e.ko) };
    }).filter(function (e) { return e.en; }).slice(0, 8)
      .map(function (e) { return { en: autoMark(e.en, text), ko: e.ko }; });
    if (!examples.length) warnings.push(label + ': 예문이 없어 뜻 문제만 나옵니다.');
    else if (!examples.some(function (e) { return exFill(e.en); })) warnings.push(label + ': 예문에 [ ] 표시가 없어 빈칸 문제는 나오지 않습니다.');
    if (kind === 'phrase' && examples.length && examples.length < 3) warnings.push(label + ': 표현은 예문 3개 이상을 권장합니다.');
    out.push({
      id: slug(text), kind: kind, text: text, ipa: str(it.ipa), meaning_ko: meaning, note: str(it.note),
      examples: examples, synonyms: rel(it.synonyms), antonyms: rel(it.antonyms),
      wrong_meanings_ko: uniq(arr(it.wrong_meanings_ko).map(str)).slice(0, 6),
      wrong_fills: uniq(arr(it.wrong_fills).map(str)).slice(0, 6),
      priority: !!it.priority, src: isrc, createdAt: now || Date.now(), st: null,
      // 사용자가 직접 지목한 항목만 바로 학습에 들어간다. 그 밖은 '후보'로 꺼진 채 들어온다
      pending: (str(it.picked_by).toLowerCase() || pickedAll) !== 'user', off: (str(it.picked_by).toLowerCase() || pickedAll) !== 'user'
    });
  });
  // 같은 호출 안의 중복은 뒤의 것을 앞에 합친다
  var byId = {}, merged = [];
  out.forEach(function (it) { if (byId[it.id]) { var m = mergeItem(byId[it.id], it); merged[merged.indexOf(byId[it.id])] = m; byId[it.id] = m; } else { byId[it.id] = it; merged.push(it); } });
  return { items: merged, errors: errors, warnings: warnings };
}

/** 이미 있는 항목에 새 내용을 합친다. 학습 기록(st)과 처음 등록 시각은 유지한다. */
function mergeItem(old, inc) {
  var seen = {}, ex = [];
  arr(old.examples).concat(arr(inc.examples)).forEach(function (e) {
    var k = exPlain(e.en).toLowerCase(); if (!seen[k]) { seen[k] = 1; ex.push(e); }
  });
  function relMerge(a, b) { var s = {}, o = []; arr(a).concat(arr(b)).forEach(function (x) { var k = x.text.toLowerCase(); if (!s[k]) { s[k] = 1; o.push(x); } }); return o.slice(0, 8); }
  return {
    id: old.id, kind: old.kind, text: old.text, ipa: old.ipa || inc.ipa, meaning_ko: old.meaning_ko,
    note: old.note || inc.note, examples: ex.slice(0, 12),
    synonyms: relMerge(old.synonyms, inc.synonyms), antonyms: relMerge(old.antonyms, inc.antonyms),
    wrong_meanings_ko: uniq(arr(old.wrong_meanings_ko).concat(arr(inc.wrong_meanings_ko))).slice(0, 6),
    wrong_fills: uniq(arr(old.wrong_fills).concat(arr(inc.wrong_fills))).slice(0, 6),
    priority: !!(old.priority || inc.priority), src: old.src || inc.src || null,
    createdAt: old.createdAt || inc.createdAt, st: old.st || null,
    // 후보로 있던 항목을 사용자가 지목해 다시 등록하면 학습에 들어간다. 사용자가 끈 항목은 꺼진 채로 둔다
    pending: !!(old.pending && inc.pending), off: old.pending ? !!inc.pending : !!old.off
  };
}

/* ---------- 간격 계산 ---------- */
function learned(it) { return !!(it.st && it.st.h != null); }
function active(it) { return !it.off; }
/** 등록한 지 7일 이내, 또는 늦게 시작했다면 시작한 지 7일 이내. */
function isRecent(it, now) {
  var t = Math.max(it.createdAt || 0, (it.st && it.st.intro) || 0);
  return now - t < CFG.recentDays * DAY;
}
function recentLeft(it, now) {
  var t = Math.max(it.createdAt || 0, (it.st && it.st.intro) || 0);
  return Math.max(0, Math.ceil((t + CFG.recentDays * DAY - now) / DAY));
}
function recallP(st, now) {
  if (!st || st.h == null || !st.last) return null;
  return Math.pow(2, -Math.max(0, now - st.last) / DAY / st.h);
}
function stage(it) { return !learned(it) ? 'queued' : (it.st.h >= CFG.familiarH ? 'familiar' : 'learning'); }
function nextDue(st) { return (!st || st.h == null) ? null : st.last + st.h * Math.log2(1 / CFG.dueP) * DAY; }

/** kind: intro | seen_ok | seen_new | right | wrong | retry_right | retry_wrong */
function applyResult(st, kind, now) {
  var s = { h: null, last: null, intro: null, seen: 0, right: 0, wrong: 0, recent: '', sq: 0 };
  if (st) for (var k in s) if (st[k] != null) s[k] = st[k];
  var quiz = kind === 'right' || kind === 'wrong';
  if (s.h == null) { s.h = 1; s.intro = now; }
  else {
    var scale = s.last ? Math.min(1, (now - s.last) / DAY / s.h) : 1; // 방금 본 항목은 거의 늘리지 않는다
    if (kind === 'right') s.h *= 1 + 1.0 * scale;
    else if (kind === 'seen_ok') s.h *= 1 + 0.3 * scale;
    else if (kind === 'seen_new') s.h *= 0.8;
    else if (kind === 'wrong') s.h *= 0.5;
  }
  s.h = Math.min(CFG.hCap, Math.max(CFG.hMin, s.h));
  s.seen += 1;
  if (quiz) {
    if (kind === 'right') s.right += 1; else s.wrong += 1;
    s.recent = (s.recent + (kind === 'right' ? '1' : '0')).slice(-5);
    s.sq = 0;
  } else if (kind === 'seen_ok' || kind === 'seen_new' || kind === 'intro') s.sq += 1;
  s.last = now;
  return s;
}

/* ---------- 카드 고르기 ---------- */
function fillsOf(it) { return arr(it.examples).map(function (e) { return exFill(e.en); }).filter(Boolean); }
function pickExample(it, n) { var ex = arr(it.examples); return ex.length ? ex[(n || 0) % ex.length] : null; }

function buildQuiz(it, type, items, rnd) {
  rnd = rnd || Math.random;
  var others = items.filter(function (x) { return x.id !== it.id; });
  var same = function (a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); };
  function pack(correct, wrong) {
    wrong = uniq(wrong).filter(function (w) { return !same(w, correct); });
    if (wrong.length < 3) return null;
    return shuffle([{ label: correct, ok: true }].concat(wrong.slice(0, 3).map(function (l) { return { label: l, ok: false }; })), rnd);
  }
  if (type === 'meaning') {
    var own = shuffle(arr(it.wrong_meanings_ko), rnd);
    var opts = pack(it.meaning_ko, own.concat(shuffle(others.map(function (o) { return o.meaning_ko; }), rnd)));
    var ex = pickExample(it, (it.st && it.st.seen) || 0);
    return opts && { type: type, ex: ex, options: opts };
  }
  if (type === 'cloze') {
    var marked = arr(it.examples).filter(function (e) { return exFill(e.en); });
    if (!marked.length) return null;
    var e = marked[Math.floor(rnd() * marked.length)], fill = exFill(e.en);
    var pool = shuffle(arr(it.wrong_fills), rnd).concat(shuffle(others.filter(function (o) { return o.kind === it.kind; })
      .map(function (o) { return fillsOf(o)[0] || o.text; }), rnd));
    var o2 = pack(fill, pool);
    return o2 && { type: type, ex: e, fill: fill, options: o2 };
  }
  if (type === 'synonym') {
    var syn = arr(it.synonyms).map(function (x) { return x.text; }), ant = arr(it.antonyms).map(function (x) { return x.text; });
    if (!syn.length && !ant.length) return null;
    var askAnt = ant.length && (!syn.length || rnd() < 0.4);
    var correct = askAnt ? ant[Math.floor(rnd() * ant.length)] : syn[Math.floor(rnd() * syn.length)];
    var block = (askAnt ? ant : syn).concat([it.text]).map(function (s) { return s.toLowerCase(); });
    var sameKind = others.filter(function (o) { return o.kind === it.kind; }), otherKind = others.filter(function (o) { return o.kind !== it.kind; });
    var texts = function (l) { return l.map(function (o) { return o.text; }).concat([].concat.apply([], l.map(function (o) { return arr(o.synonyms).map(function (x) { return x.text; }); }))); };
    var pool2 = shuffle(askAnt ? syn : ant, rnd).concat(shuffle(texts(sameKind), rnd), shuffle(texts(otherKind), rnd))
      .filter(function (w) { return block.indexOf(String(w).toLowerCase()) === -1; });
    var o3 = pack(correct, pool2);
    return o3 && { type: type, rel: askAnt ? 'ant' : 'syn', options: o3 };
  }
  if (type === 'recall') return { type: type, ex: pickExample(it, (it.st && it.st.seen) || 0) };
  return null;
}

/** 반감기에 따라 퀴즈 유형을 정하고, 만들 수 없으면 쉬운 유형으로 내려간다. */
function resolveQuiz(it, items, rnd, prefer) {
  rnd = rnd || Math.random;
  var h = (it.st && it.st.h) || 0, order;
  if (prefer) order = [prefer, 'meaning', 'recall'];
  else if (h < 3) order = ['meaning', 'recall'];
  else if (h < 10) order = (it.kind === 'word' && rnd() < 0.5 ? ['synonym', 'cloze'] : ['cloze', 'synonym']).concat(['meaning', 'recall']);
  else order = (rnd() < 0.5 ? ['recall', 'cloze'] : ['cloze', 'recall']).concat(['meaning']);
  for (var i = 0; i < order.length; i++) { var q = buildQuiz(it, order[i], items, rnd); if (q) return q; }
  return { type: 'recall', ex: null };
}

/** 표현은 노출 2번에 퀴즈 1번, 단어는 노출 1번에 퀴즈 1~2번. */
function wantsQuiz(it, rnd) {
  var sq = (it.st && it.st.sq) || 0;
  return it.kind === 'phrase' ? sq >= 2 : (sq >= 1 || (rnd || Math.random)() < 0.2);
}

function recentAccuracy(sessions, n) {
  var res = [];
  sessions.slice().sort(function (a, b) { return b.startedAt - a.startedAt; }).some(function (s) {
    arr(s.ev).slice().reverse().some(function (e) { if ((e.r === 1 || e.r === 0) && !e.x) res.push(e.r); return res.length >= n; });
    return res.length >= n;
  });
  return res.length < 10 ? null : res.reduce(function (a, b) { return a + b; }, 0) / res.length;
}

function newQuota(items, sessions, now) {
  var ls = items.filter(active).filter(learned);
  var due = ls.filter(function (i) { return recallP(i.st, now) < CFG.dueP; }).length;
  var acc = recentAccuracy(sessions, 20);
  if (ls.length < CFG.coldBelow) return CFG.newMaxCold;
  if (due <= 10 && (acc == null || acc >= 0.8)) return CFG.newMax;
  return due <= 20 ? 1 : 0;
}

function pickNew(fresh, quota) {
  var order = fresh.slice().sort(function (a, b) { return (b.priority ? 1 : 0) - (a.priority ? 1 : 0) || (a.createdAt || 0) - (b.createdAt || 0); });
  var out = [];
  while (out.length < quota && order.length) {
    var head = order.shift(); out.push(head);
    // 같은 원문에서 나온 항목을 이어서 소개한다
    if (head.src && head.src.text) {
      for (var i = 0; i < order.length && out.length < quota;) {
        if (order[i].src && order[i].src.text === head.src.text) out.push(order.splice(i, 1)[0]); else i++;
      }
    }
  }
  return out;
}

/** 이번 세션에 시작할 새 항목. 최근 등록한 것은 투입 조건을 기다리지 않는다. */
function planNew(items, sessions, now) {
  var fresh = items.filter(active).filter(function (i) { return !learned(i); });
  var news = pickNew(fresh.filter(function (i) { return isRecent(i, now); }), CFG.newMaxRecent);
  var quota = newQuota(items, sessions, now);
  if (news.length < quota) news = news.concat(pickNew(fresh.filter(function (i) { return news.indexOf(i) === -1; }), quota - news.length));
  return news;
}

function buildSession(all, sessions, now, rnd) {
  rnd = rnd || Math.random;
  var items = all.filter(active);
  var ls = items.filter(learned), fresh = items.filter(function (i) { return !learned(i); });
  var scored = ls.map(function (i) { return { i: i, p: recallP(i.st, now) }; }).sort(function (a, b) { return a.p - b.p; });
  var due = scored.filter(function (x) { return x.p < CFG.dueP; });
  var news = planNew(all, sessions, now);
  var recent = scored.filter(function (x) { return isRecent(x.i, now); })
    .sort(function (a, b) { return (a.i.st.seen - b.i.st.seen) || (a.p - b.p); });
  var hasRecent = recent.length > 0 || news.some(function (i) { return isRecent(i, now); });
  var room = Math.max(0, (hasRecent ? CFG.targetRecent : CFG.target) - news.length);
  // 1) 최근 항목은 복습 시점과 무관하게 넣되, 오래된 복습 대상의 자리를 조금 남긴다
  var dueOld = due.filter(function (x) { return !isRecent(x.i, now); });
  var review = recent.slice(0, Math.max(0, room - Math.min(CFG.keepDue, dueOld.length))).map(function (x) { return x.i; });
  // 2) 복습 시점이 된 항목
  due.forEach(function (x) { if (review.length < room && review.indexOf(x.i) === -1) review.push(x.i); });
  // 3) 남는 자리는 본 횟수가 적은 표현부터
  if (review.length < room) {
    scored.filter(function (x) { return review.indexOf(x.i) === -1; })
      .sort(function (a, b) { return (a.i.kind === 'phrase' ? 0 : 1) - (b.i.kind === 'phrase' ? 0 : 1) || (a.i.st.seen - b.i.st.seen) || (a.p - b.p); })
      .slice(0, room - review.length).forEach(function (x) { review.push(x.i); });
  }
  var first = shuffle(review.map(function (i) { return { id: i.id, type: wantsQuiz(i, rnd) ? 'quiz' : 'expose' }; }), rnd);
  var firstType = {}; first.forEach(function (c) { firstType[c.id] = c.type; });
  // 한 장 더: 최근 항목(본 횟수 적은 순) 다음에 기억 확률이 낮은 항목
  var extra = [];
  recent.concat(due).forEach(function (x) { if (review.indexOf(x.i) !== -1 && extra.indexOf(x.i) === -1) extra.push(x.i); });
  var maxSeconds = Math.max(0, Math.min(hasRecent ? 4 : 3, CFG.maxCards - first.length - news.length * 2));
  var seconds = extra.slice(0, maxSeconds).map(function (i) { return { id: i.id, type: firstType[i.id] === 'quiz' ? 'expose' : 'quiz' }; });
  var seq = first.slice();
  news.forEach(function (i, k) { seq.splice(Math.min(seq.length, 1 + k * 2), 0, { id: i.id, type: 'intro' }); });
  var tail = shuffle(seconds.concat(news.map(function (i) { return { id: i.id, type: 'quiz', prefer: 'meaning' }; })), rnd);
  seq = seq.concat(tail);
  for (var k = 1; k < seq.length; k++) { // 같은 항목이 연달아 나오지 않게
    if (seq[k].id === seq[k - 1].id) {
      var moved = false, id = seq[k].id;
      for (var j = k + 1; j < seq.length; j++) if (seq[j].id !== id) { var t = seq[k]; seq[k] = seq[j]; seq[j] = t; moved = true; break; }
      if (!moved) { // 뒤에 바꿀 카드가 없으면 앞쪽의 빈 자리로 옮긴다. 소개 카드보다 앞으로는 가지 않는다
        var floor = 0; for (var f = 0; f < k; f++) if (seq[f].id === id && seq[f].type === 'intro') floor = f + 2;
        for (var m = k - 2; m >= floor; m--) if (seq[m].id !== id && (m === 0 || seq[m - 1].id !== id)) { seq.splice(m, 0, seq.splice(k, 1)[0]); break; }
      }
    }
  }
  return { cards: seq, newIds: news.map(function (i) { return i.id; }), dueCount: due.length, freshCount: fresh.length,
    recentCount: recent.length + news.filter(function (i) { return isRecent(i, now); }).length };
}

/* ---------- 통계 ---------- */
function dayKey(ms) { var d = new Date(ms); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
function computeStats(items, sessions, now) {
  var by = { queued: 0, learning: 0, familiar: 0, off: 0, pending: 0 };
  items.forEach(function (i) { if (i.pending) by.pending++; else if (i.off) by.off++; else by[stage(i)]++; });
  var recentN = items.filter(function (i) { return !i.off && isRecent(i, now); }).length;
  var days = {}; sessions.forEach(function (s) { if (arr(s.ev).length) days[dayKey(s.startedAt)] = 1; });
  var streak = 0, t = now;
  if (!days[dayKey(t)]) t -= DAY;
  while (days[dayKey(t)]) { streak++; t -= DAY; }
  var q = 0, r = 0, today = 0;
  sessions.forEach(function (s) {
    arr(s.ev).forEach(function (e) {
      if (dayKey(s.startedAt) === dayKey(now)) today++;
      if (now - s.startedAt <= 7 * DAY && (e.r === 1 || e.r === 0) && !e.x) { q++; r += e.r; }
    });
  });
  var due = items.filter(function (i) { return !i.off && learned(i) && recallP(i.st, now) < CFG.dueP; }).length;
  var weak = items.filter(function (i) { return !i.off && i.st && i.st.wrong > 0; })
    .sort(function (a, b) { return b.st.wrong - a.st.wrong || a.st.right - b.st.right; }).slice(0, 5);
  return { by: by, streak: streak, weekQuiz: q, weekAcc: q ? r / q : null, today: today, due: due, weak: weak, recent: recentN, total: items.length - by.pending };
}

export const Core = {
  CFG: CFG, DAY: DAY, normText: normText, slug: slug, exPlain: exPlain, exFill: exFill, autoMark: autoMark, stripFence: stripFence,
  normalizePayload: normalizePayload, mergeItem: mergeItem, learned: learned, active: active, isRecent: isRecent, recentLeft: recentLeft, planNew: planNew, recallP: recallP, stage: stage, nextDue: nextDue,
  applyResult: applyResult, pickExample: pickExample, buildQuiz: buildQuiz, resolveQuiz: resolveQuiz, wantsQuiz: wantsQuiz, recentAccuracy: recentAccuracy,
  newQuota: newQuota, pickNew: pickNew, buildSession: buildSession, computeStats: computeStats, dayKey: dayKey, shuffle: shuffle
};
export default Core;
