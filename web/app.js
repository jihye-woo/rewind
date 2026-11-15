/**
 * 앱 화면. 서버의 /api 를 호출해 항목과 세션 로그를 읽고 쓴다.
 * 세션 구성·간격 계산·등록 형식 검사는 shared/core.js 에 있고 서버와 같은 코드를 쓴다.
 * 빌드(scripts/build.mjs)가 이 파일과 core.js 를 묶어 index.html 안에 넣는다.
 */
import { Core as C } from '../shared/core.js';
import EXAMPLE from './example.json';

(function () {
  'use strict';
  var DAY = C.DAY;
  var KEY_LS = 'rewind-key';
  var VIEWS = ['study', 'items', 'add', 'stats'];
  var S = {
    mode: 'loading', note: '', warn: '', view: 'study', items: [], byId: {}, sessions: [],
    sess: null, filter: 'all', detail: null, confirmDel: false, delAsk: null,
    draftJson: '', preview: null, pick: {}, busy: false, flash: '', key: ''
  };

  var GPT_PROMPT = [
    '내가 "등록"이라고 하면, 영어 단어·표현을 아래 형식의 JSON 하나로 정리해서 코드 블록으로만 출력해 줘.',
    '',
    '무엇을 등록할지',
    '- 내가 단어·표현을 직접 짚었거나(예: "keep one\'s head down 등록") 방금 대화에서 그 표현을 물어봤다면, 그것만 등록하고 picked_by를 "user"로 한다',
    '- 문장만 붙여 넣고 무엇을 등록할지 말하지 않았다면, JSON을 바로 만들지 말고 먼저 후보를 번호 목록으로 보여 준다. 후보마다 기본형과 한 줄 뜻을 붙이고, 어느 것을 등록할지 묻는다. 내가 고른 것만 picked_by "user"로 등록한다',
    '- 내가 "알아서 골라 줘"라고 하면 고른 항목의 picked_by를 "assistant"로 한다. 이 항목은 앱에서 후보로 들어가고, 내가 앱에서 확인해야 학습에 나온다',
    '- 쉬운 단어(work hard 같은 것)는 후보에 넣지 않는다',
    '',
    '규칙',
    '- kind: 단어 하나면 "word", 두 단어 이상의 표현·패턴이면 "phrase"',
    '- text: 사전에 실리는 기본형. 패턴은 someone / something 으로 자리를 표시 (예: set someone up with something)',
    '- meaning_ko: 한국어 뜻 한 줄. 뉘앙스와 주의점은 note에 한두 문장',
    '- examples: 단어는 2개 이상, 표현은 3개 이상. 서로 다른 상황으로. 문장 안에서 해당 단어·표현에 해당하는 부분을 [ ]로 감싼다',
    '  예: "Can you [set] me [up with] a drink?"',
    '- synonyms / antonyms: 있으면 넣고, note에 차이를 한 줄로',
    '- wrong_meanings_ko: 헷갈릴 만한 틀린 뜻 3개',
    '- wrong_fills: 예문 빈칸에 넣으면 틀리는 비슷한 말 3개. [ ] 안과 같은 모양으로 (예: "put … up with")',
    '- priority: 특히 자주 쓰일 표현이면 true',
    '- 원문 문장이 있으면 source에 넣는다',
    '',
    '{',
    '  "picked_by": "user",',
    '  "source": { "text": "원문 영어 문장", "ko": "자연스러운 해석", "origin": "작품 이름(모르면 빈 문자열)" },',
    '  "items": [',
    '    {',
    '      "kind": "phrase", "text": "", "ipa": "", "meaning_ko": "", "note": "", "priority": false,',
    '      "examples": [ { "en": "", "ko": "" } ],',
    '      "synonyms": [ { "text": "", "note": "" } ], "antonyms": [ { "text": "", "note": "" } ],',
    '      "wrong_meanings_ko": [ "", "", "" ], "wrong_fills": [ "", "", "" ]',
    '    }',
    '  ]',
    '}'
  ].join('\n');

  /* ---------- helpers ---------- */
  function $(s) { return document.querySelector(s); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function lineHtml(en, blank) {
    var e = esc(en);
    return blank ? e.replace(/\[[^\]]+\]/g, '<span class="blank"></span>') : e.replace(/\[([^\]]+)\]/g, '<mark>$1</mark>');
  }
  function kindKo(k) { return k === 'phrase' ? '표현' : '단어'; }
  function stageKo(s) { return { queued: '대기', learning: '익히는 중', familiar: '익숙함' }[s]; }
  function fmtDay(ms) { var d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate(); }
  function fmtTime(ms) { var d = new Date(ms); return fmtDay(ms) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function dueText(it, now) {
    var t = C.nextDue(it.st); if (t == null) return '';
    var d = Math.ceil((t - now) / DAY);
    return t <= now ? '복습할 때' : (d <= 1 ? '내일쯤 복습' : d + '일 뒤 복습');
  }
  function dots(st) {
    var r = (st && st.recent) || '', h = '';
    for (var i = 0; i < 5; i++) h += '<i class="' + (r[i] === '1' ? 'o' : r[i] === '0' ? 'x' : '') + '"></i>';
    return '<span class="dots" aria-label="최근 퀴즈 ' + r.length + '회">' + h + '</span>';
  }
  function reindex() { S.byId = {}; S.items.forEach(function (i) { S.byId[i.id] = i; }); }

  /* ---------- 서버와 주고받기 ---------- */
  function readKey() {
    // 처음 열 때는 주소 끝의 #key=... 에서 접속 키를 받아 이 브라우저에 저장하고, 주소에서는 지운다
    var m = (location.hash || '').match(/key=([^&]+)/);
    if (m) {
      try { localStorage.setItem(KEY_LS, decodeURIComponent(m[1])); } catch (e) { /* 저장 불가: 이번 방문에만 쓴다 */ }
      S.key = decodeURIComponent(m[1]);
      history.replaceState(null, '', location.pathname + '#study');
      return;
    }
    try { S.key = localStorage.getItem(KEY_LS) || ''; } catch (e) { S.key = ''; }
  }
  async function api(method, path, body) {
    var res = await fetch(path, {
      method: method,
      headers: Object.assign({ authorization: 'Bearer ' + S.key }, body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 401) { var e = new Error('unauthorized'); e.code = 401; throw e; }
    if (res.status === 204) return null;
    var data = await res.json().catch(function () { return null; });
    if (!res.ok) { var err = new Error((data && data.error) || ('HTTP ' + res.status)); err.code = res.status; throw err; }
    return data;
  }

  // 쓰기 대기열. 같은 대상에 대한 쓰기는 마지막 것만 남기고, 한 번에 하나씩 보낸다.
  var queue = [], latest = {}, pumping = false;
  function qwrite(key, job) {
    if (!(key in latest)) queue.push(key);
    latest[key] = job;
    if (!pumping) pump();
  }
  function busyWriting() { return pumping || queue.length > 0; }
  async function pump() {
    pumping = true;
    while (queue.length) {
      var key = queue[0], job = latest[key], tries = 0;
      for (;;) {
        try { await job(); break; }
        catch (err) {
          if (err.code === 401) { S.mode = 'nokey'; render(); break; }
          if (!err.code && tries < 1) { tries++; await sleep(1500); continue; } // 네트워크 오류는 한 번 더
          S.warn = '저장하지 못했습니다. 연결을 확인한 뒤 화면을 새로 고치면 마지막으로 저장된 상태부터 이어집니다.';
          showWarn(); break;
        }
      }
      if (latest[key] === job) { delete latest[key]; queue.shift(); } // 그 사이 새 내용이 들어왔으면 한 번 더 보낸다
    }
    pumping = false;
  }

  /** 학습 상태·켜짐/꺼짐만 바꾼다. 등록 내용은 서버의 add-items 만 바꾼다. */
  function setItemState(id, patch) {
    var it = S.byId[id]; if (!it) return;
    var next = Object.assign({}, it, patch);
    S.items[S.items.indexOf(it)] = next; S.byId[id] = next;
    var merged = Object.assign({}, (latest['item:' + id] && latest['item:' + id].patch) || {}, patch);
    var job = function () { return api('PATCH', '/api/items/' + encodeURIComponent(id), merged); };
    job.patch = merged;
    qwrite('item:' + id, job);
  }
  function removeItem(id) {
    S.items = S.items.filter(function (x) { return x.id !== id; }); delete S.byId[id];
    qwrite('item:' + id, function () { return api('DELETE', '/api/items/' + encodeURIComponent(id)); });
  }
  function setSession(doc, id) {
    var i = S.sessions.findIndex(function (x) { return x.id === id; });
    var row = Object.assign({ id: id }, doc);
    if (i === -1) S.sessions.push(row); else S.sessions[i] = row;
    qwrite('sess:' + id, function () { return api('PUT', '/api/sessions/' + encodeURIComponent(id), doc); });
  }
  async function load() {
    try {
      var d = await api('GET', '/api/state');
      S.items = d.items || []; S.sessions = d.sessions || []; reindex();
      S.mode = 'ready'; S.note = '';
    } catch (e) {
      if (e.code === 401) S.mode = 'nokey';
      else { S.mode = S.mode === 'ready' ? 'ready' : 'error'; S.note = '서버에서 데이터를 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.'; }
    }
    render();
  }
  /** GPT가 MCP로 넣은 항목이 보이도록, 화면으로 돌아올 때 다시 읽는다. 세션 중이거나 쓰는 중이면 건너뛴다. */
  function refreshIfIdle() {
    if (S.mode !== 'ready' || busyWriting() || (S.sess && !S.sess.done) || S.preview || S.busy) return;
    load();
  }
  function init() {
    readKey(); route(); render();
    if (!S.key) { S.mode = 'nokey'; render(); return; }
    load();
  }

  /* ---------- pieces ---------- */
  function relsHtml(it) {
    function row(lab, list) {
      if (!list || !list.length) return '';
      return '<div><span class="lab">' + lab + '</span> ' + list.map(function (x) {
        return '<span class="w">' + esc(x.text) + '</span>' + (x.note ? ' <span class="n">' + esc(x.note) + '</span>' : '');
      }).join(' · ') + '</div>';
    }
    var h = row('유의어', it.synonyms) + row('반의어', it.antonyms);
    return h ? '<div class="rels">' + h + '</div>' : '';
  }
  function captionHtml(src, tag) {
    if (!src || !src.text) return '';
    var line = esc(src.text);
    S.items.forEach(function (it) {
      if (it.kind === 'word' && it.src && it.src.text === src.text) {
        line = line.replace(new RegExp('\\b(' + it.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\b', 'i'), '<mark>$1</mark>');
      }
    });
    return '<div class="caption"><div class="tag">' + esc(tag || '원문') + (src.origin ? ' · ' + esc(src.origin) : '') + '</div>' +
      '<div class="line">' + line + '</div>' + (src.ko ? '<div class="ko">' + esc(src.ko) + '</div>' : '') + '</div>';
  }
  function detailHtml(it, ex) {
    return '<div class="meaning">' + esc(it.meaning_ko) + '</div>' +
      (ex ? '<div><div class="en">' + lineHtml(ex.en) + '</div>' + (ex.ko ? '<div class="ko">' + esc(ex.ko) + '</div>' : '') + '</div>' : '') +
      (it.note ? '<div class="note">' + esc(it.note) + '</div>' : '') + relsHtml(it);
  }
  function optsHtml(q, en) {
    var a = S.sess.answered;
    return '<div class="opts">' + q.options.map(function (o, i) {
      var cls = 'opt' + (en ? ' en-opt' : '');
      if (a != null) cls += o.ok ? ' right' : (a === i ? ' wrong' : '');
      return '<button class="' + cls + '" data-act="answer" data-i="' + i + '"' + (a != null ? ' disabled' : '') + '><span class="k">' + (i + 1) + '</span><span>' + esc(o.label) + '</span></button>';
    }).join('') + '</div>';
  }

  /* ---------- study ---------- */
  function startSession() {
    var now = Date.now(), plan = C.buildSession(S.items, S.sessions, now);
    if (!plan.cards.length) return;
    S.sess = { id: 's' + now, startedAt: now, cards: plan.cards, idx: 0, ev: [], retryCount: 0, newIds: plan.newIds, phase: 'front', answered: null, cur: null, done: false };
    prepare(); render(); window.scrollTo(0, 0);
  }
  function prepare() {
    var s = S.sess;
    while (s.idx < s.cards.length && (!S.byId[s.cards[s.idx].id] || S.byId[s.cards[s.idx].id].off)) s.idx++; // 지웠거나 끈 항목은 건너뛴다
    if (s.idx >= s.cards.length) { finish(); return; }
    var c = s.cards[s.idx], it = S.byId[c.id];
    if (c.type === 'quiz') s.cur = C.resolveQuiz(it, S.items, Math.random, c.prefer);
    else s.cur = { type: c.type, ex: C.pickExample(it, (it.st && it.st.seen) || 0) };
    s.phase = 'front'; s.answered = null;
  }
  function persistSession() {
    var s = S.sess;
    setSession({ startedAt: s.startedAt, endedAt: s.endedAt || null, n: s.ev.length, ev: s.ev.slice() }, s.id);
  }
  function record(kind, extra) {
    var s = S.sess, c = s.cards[s.idx], it = S.byId[c.id], now = Date.now();
    setItemState(it.id, { st: C.applyResult(it.st, c.retry ? 'retry' : kind, now) });
    var e = { i: it.id, t: s.cur.type, at: now };
    if (extra && extra.r != null) e.r = extra.r;
    if (extra && extra.v) e.v = extra.v;
    if (c.retry) e.x = 1;
    s.ev.push(e); persistSession();
    if (extra && extra.r === 0 && !c.retry && s.retryCount < C.CFG.retryMax) {
      s.cards.push({ id: it.id, type: 'quiz', prefer: s.cur.type, retry: true }); s.retryCount++;
    }
  }
  function advance() {
    var s = S.sess; s.idx++;
    if (s.idx >= s.cards.length) finish(); else prepare();
    render(); window.scrollTo(0, 0);
  }
  function finish() { var s = S.sess; if (s.done) return; s.done = true; s.endedAt = Date.now(); if (s.ev.length) persistSession(); }

  function studyHome() {
    var now = Date.now(), st = C.computeStats(S.items, S.sessions, now);
    if (!S.items.length) {
      return '<div class="card empty"><p>아직 등록한 항목이 없습니다.</p><p class="small">등록 화면에서 GPT가 정리한 JSON을 붙여 넣거나 예시를 불러오세요.</p>' +
        '<a class="btn primary" href="#add" style="text-decoration:none;display:inline-block">등록 화면으로</a></div>';
    }
    var quota = C.planNew(S.items, S.sessions, now).length;
    var cand = st.by.pending ? '<div class="card ctl-card"><div><b>확인을 기다리는 후보 ' + st.by.pending + '개</b><div class="small">GPT가 문장에서 고른 항목입니다. 학습에 넣을 것을 골라 주세요.</div></div><button class="btn sm" data-act="go-pending">고르기</button></div>' : '';
    var latestSrc = null;
    S.items.filter(C.active).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).some(function (i) { if (i.src && i.src.text) { latestSrc = i.src; return true; } return false; });
    var learnedN = st.by.learning + st.by.familiar, plan;
    if (!learnedN) plan = '새 항목 ' + quota + '개로 시작합니다';
    else {
      plan = st.due ? '복습할 항목 ' + st.due + '개를 먼저 봅니다' : '복습 시점이 된 항목이 없어, 본 횟수가 적은 표현부터 다시 봅니다';
      if (quota) plan += '. 새 항목 ' + quota + '개도 시작합니다';
    }
    if (st.recent) plan += '. 최근 넣은 항목 ' + st.recent + '개는 일주일 동안 매 세션에 나옵니다';
    if (!learnedN && !quota) {
      return cand + '<div class="card empty"><p>학습에 포함된 항목이 없습니다.</p><p class="small">항목 화면에서 끈 항목을 다시 켜거나 새 항목을 등록하세요.</p>' +
        '<a class="btn primary" href="#items" style="text-decoration:none;display:inline-block">항목 화면으로</a></div>';
    }
    return cand + captionHtml(latestSrc, '가장 최근에 넣은 원문') +
      '<div class="tiles">' +
      '<div class="tile"><b>' + st.due + '</b><span>복습할 항목</span></div>' +
      '<div class="tile"><b>' + st.by.queued + '</b><span>대기 중인 새 항목</span></div>' +
      '<div class="tile"><b>' + st.streak + '</b><span>연속 학습 일수</span></div>' +
      '</div>' +
      '<div class="card"><h2>오늘의 세션</h2><p class="small">' + esc(plan) + '. 한 번에 항목 ' + (st.recent ? C.CFG.target + '~' + C.CFG.targetRecent : C.CFG.target) + '개 안팎입니다.</p>' +
      '<button class="btn primary" data-act="start">세션 시작</button></div>';
  }

  function sessionView() {
    var s = S.sess;
    if (s.done) return summaryView();
    var c = s.cards[s.idx], it = S.byId[c.id], q = s.cur, back = s.phase === 'back', h = '';
    h += '<div class="progress"><span>' + (s.idx + 1) + ' / ' + s.cards.length + '</span><div class="bar"><i style="width:' + Math.round(s.idx / s.cards.length * 100) + '%"></i></div>' +
      '<button class="btn quiet" data-act="quit">그만하기</button></div>';
    var k = kindKo(it.kind);
    if (q.type === 'intro') {
      h += captionHtml(it.src, '이 장면에서 나온 말');
      h += '<div class="card"><div class="kind">새 항목 · ' + k + '</div><div class="target">' + esc(it.text) + '</div>' +
        (it.ipa ? '<div class="ipa">' + esc(it.ipa) + '</div>' : '') +
        '<div class="meaning">' + esc(it.meaning_ko) + '</div>' + (it.note ? '<div class="note">' + esc(it.note) + '</div>' : '') +
        (it.examples.length ? '<hr><div class="exlist">' + it.examples.slice(0, 5).map(function (e) {
          return '<div><div class="en">' + lineHtml(e.en) + '</div>' + (e.ko ? '<div class="ko">' + esc(e.ko) + '</div>' : '') + '</div>';
        }).join('') + '</div>' : '') + relsHtml(it) + '</div>' +
        '<button class="btn primary" data-act="intro-next" data-primary>다음</button>';
    } else if (q.type === 'expose') {
      h += '<div class="card"><div class="kind">보고 익히기 · ' + k + '</div>' +
        (q.ex ? '<div class="en">' + lineHtml(q.ex.en) + '</div>' : '<div class="target">' + esc(it.text) + '</div>');
      if (back) {
        h += (q.ex && q.ex.ko ? '<div class="ko">' + esc(q.ex.ko) + '</div>' : '') + '<hr><div class="target" style="font-size:20px">' + esc(it.text) + '</div>' + detailHtml(it, null);
      }
      h += '</div>';
      h += back ? '<div class="row2"><button class="btn" data-act="seen" data-v="new">아직 낯설어요</button><button class="btn primary" data-act="seen" data-v="ok" data-primary>익숙해요</button></div>'
        : '<button class="btn primary" data-act="flip" data-primary>뜻 보기</button>';
    } else if (q.type === 'recall') {
      h += '<div class="card"><div class="kind">떠올리기 · ' + k + '</div><div class="meaning">' + esc(it.meaning_ko) + '</div>' +
        (q.ex && q.ex.ko ? '<div class="ko">예: ' + esc(q.ex.ko) + '</div>' : '') +
        (back ? '<hr><div class="target">' + esc(it.text) + '</div>' + (q.ex ? '<div class="en">' + lineHtml(q.ex.en) + '</div>' : '') + (it.note ? '<div class="note">' + esc(it.note) + '</div>' : '') + relsHtml(it)
          : '<div class="q">영어로 떠올려 본 뒤 정답을 확인하세요.</div>') + '</div>';
      h += back ? '<div class="row2"><button class="btn" data-act="self" data-r="0">못 떠올렸어요</button><button class="btn primary" data-act="self" data-r="1" data-primary>떠올렸어요</button></div>'
        : '<button class="btn primary" data-act="flip" data-primary>정답 보기</button>';
    } else {
      var title = { meaning: '뜻 고르기', cloze: '빈칸 채우기', synonym: q.rel === 'ant' ? '반의어 고르기' : '유의어 고르기' }[q.type];
      h += '<div class="card"><div class="kind">' + title + ' · ' + k + (c.retry ? ' · 다시 풀기' : '') + '</div>';
      if (q.type === 'meaning') {
        h += '<div class="target">' + esc(it.text) + '</div>' + (q.ex ? '<div class="en">' + lineHtml(q.ex.en) + '</div>' : '') + '<div class="q">이 말의 뜻은?</div>' + optsHtml(q, false);
      } else if (q.type === 'cloze') {
        h += '<div class="en">' + lineHtml(q.ex.en, s.answered == null) + '</div>' + (q.ex.ko ? '<div class="ko">' + esc(q.ex.ko) + '</div>' : '') + '<div class="q">빈칸에 들어갈 말은?</div>' + optsHtml(q, true);
      } else {
        h += '<div class="target">' + esc(it.text) + '</div><div class="q">' + (q.rel === 'ant' ? '뜻이 반대인 말은?' : '뜻이 가까운 말은?') + '</div>' + optsHtml(q, true);
      }
      if (s.answered != null) {
        var ok = q.options[s.answered].ok;
        h += '<hr><div class="verdict ' + (ok ? 'ok' : 'no') + '">' + (ok ? '맞았습니다' : '틀렸습니다' + (c.retry ? '' : '. 세션 끝에 한 번 더 나옵니다')) + '</div>' +
          detailHtml(it, q.type === 'synonym' ? C.pickExample(it, 0) : (q.type === 'meaning' && q.ex ? { en: q.ex.en, ko: q.ex.ko } : null));
      }
      h += '</div>';
      if (s.answered != null) h += '<button class="btn primary" data-act="next" data-primary>다음</button>';
    }
    return h;
  }

  function summaryView() {
    var s = S.sess, q = 0, r = 0, wrong = {};
    s.ev.forEach(function (e) { if ((e.r === 1 || e.r === 0) && !e.x) { q++; r += e.r; if (!e.r) wrong[e.i] = 1; } });
    function names(ids) { return ids.map(function (id) { return S.byId[id] ? '<span class="w en" style="font-size:16px">' + esc(S.byId[id].text) + '</span>' : ''; }).filter(Boolean).join(' · '); }
    var started = s.newIds.filter(function (id) { return S.byId[id] && C.learned(S.byId[id]); });
    return '<div class="card"><h2>세션을 마쳤습니다</h2>' +
      '<div class="tiles"><div class="tile"><b>' + s.ev.length + '</b><span>본 카드</span></div>' +
      '<div class="tile"><b>' + (q ? r + ' / ' + q : '없음') + '</b><span>퀴즈 정답</span></div>' +
      '<div class="tile"><b>' + started.length + '</b><span>새로 시작한 항목</span></div></div>' +
      (started.length ? '<div><div class="sec">새로 시작</div>' + names(started) + '</div>' : '') +
      (Object.keys(wrong).length ? '<div><div class="sec">틀린 항목 · 다음 세션에 먼저 나옵니다</div>' + names(Object.keys(wrong)) + '</div>' : '') +
      '</div><div class="row2"><button class="btn" data-act="close-sess">처음 화면으로</button><button class="btn primary" data-act="start" data-primary>한 세션 더</button></div>';
  }

  /* ---------- items ---------- */
  function itemsView() {
    var now = Date.now();
    if (S.detail && S.byId[S.detail]) return itemDetail(S.byId[S.detail], now);
    var f = S.filter, list = S.items.filter(function (i) {
      if (f === 'pending') return !!i.pending;
      if (f === 'off') return !!i.off && !i.pending;
      if (f === 'recent') return !i.off && C.isRecent(i, now);
      return f === 'all' || i.kind === f || (!i.off && C.stage(i) === f);
    }).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0) || a.text.localeCompare(b.text); });
    var chips = [['all', '전체'], ['word', '단어'], ['phrase', '표현'], ['recent', '최근 7일'], ['queued', '대기'], ['learning', '익히는 중'], ['familiar', '익숙함'], ['off', '꺼짐'], ['pending', '후보']];
    var h = '<div class="chips">' + chips.map(function (c) {
      return '<button class="chip" data-act="filter" data-f="' + c[0] + '" aria-pressed="' + (f === c[0]) + '">' + c[1] + '</button>';
    }).join('') + '</div>';
    if (!list.length) return h + '<div class="card empty">' + (S.items.length ? '이 조건에 맞는 항목이 없습니다.' : '아직 등록한 항목이 없습니다.') + '</div>';
    return h + '<div class="small">' + list.length + '개 · 스위치를 끄면 세션에 나오지 않고 기록은 남습니다</div><div class="list">' + list.map(function (i) {
      var st = i.st || {}, sg = C.stage(i), id = esc(i.id), left = C.recentLeft(i, now);
      var ctl = S.delAsk === i.id
        ? '<span class="small">기록까지 삭제할까요?</span><button class="btn sm" data-act="row-del-cancel">취소</button><button class="btn sm danger" data-act="row-del-yes" data-id="' + id + '">삭제</button>'
        : (i.pending ? '<button class="btn sm primary" data-act="toggle" data-id="' + id + '">학습에 넣기</button>' : switchHtml(i)) + '<button class="btn sm quiet danger" data-act="row-del" data-id="' + id + '">삭제</button>';
      return '<div class="row item-row' + (i.off ? ' is-off' : '') + '"><button class="row-main" data-act="open" data-id="' + id + '"><div class="t"><b>' + esc(i.text) + '</b>' +
        '<span class="pill ' + (i.off ? '' : sg) + '">' + (i.pending ? '후보' : i.off ? '꺼짐' : stageKo(sg)) + '</span></div>' +
        '<div class="m">' + esc(i.meaning_ko) + '</div><div class="s"><span>' + kindKo(i.kind) + '</span>' +
        (C.learned(i) ? '<span>본 ' + st.seen + '회</span><span>맞힘 ' + st.right + ' · 틀림 ' + st.wrong + '</span>' + dots(st) + (i.off ? '' : '<span>' + dueText(i, now) + '</span>') : '<span>아직 시작 전</span>') +
        (!i.off && left ? '<span class="tag">매 세션 노출 ' + left + '일 남음</span>' : '') +
        '</div></button><div class="row-ctl">' + ctl + '</div></div>';
    }).join('') + '</div>';
  }
  function switchHtml(i) {
    return '<button class="switch" role="switch" aria-checked="' + (!i.off) + '" aria-label="' + esc(i.text) + ' 학습에 포함" data-act="toggle" data-id="' + esc(i.id) + '"><i></i><span>' + (i.off ? '꺼짐' : '학습 중') + '</span></button>';
  }
  function itemDetail(it, now) {
    var st = it.st || {}, sg = C.stage(it);
    return '<button class="btn quiet" data-act="back" style="align-self:flex-start">← 목록으로</button>' + captionHtml(it.src, '원문') +
      '<div class="card"><div class="kind">' + kindKo(it.kind) + ' · <span class="pill ' + (it.off ? '' : sg) + '">' + (it.pending ? '후보' : it.off ? '꺼짐' : stageKo(sg)) + '</span></div>' +
      '<div class="target">' + esc(it.text) + '</div>' + (it.ipa ? '<div class="ipa">' + esc(it.ipa) + '</div>' : '') +
      '<div class="meaning">' + esc(it.meaning_ko) + '</div>' + (it.note ? '<div class="note">' + esc(it.note) + '</div>' : '') +
      (it.examples.length ? '<hr><div class="exlist">' + it.examples.map(function (e) { return '<div><div class="en">' + lineHtml(e.en) + '</div>' + (e.ko ? '<div class="ko">' + esc(e.ko) + '</div>' : '') + '</div>'; }).join('') + '</div>' : '') +
      relsHtml(it) + '</div>' +
      '<div class="tiles"><div class="tile"><b>' + (st.seen || 0) + '</b><span>본 횟수</span></div><div class="tile"><b>' + (st.right || 0) + ' / ' + (st.wrong || 0) + '</b><span>맞힘 / 틀림</span></div>' +
      '<div class="tile"><b>' + (C.learned(it) ? (st.h < 1 ? '1일 미만' : Math.round(st.h) + '일') : '없음') + '</b><span>기억 반감기</span></div></div>' +
      (C.learned(it) ? '<div class="small">최근 퀴즈 ' + dots(st) + (it.off ? '' : ' · ' + dueText(it, now)) + ' · 처음 본 날 ' + fmtDay(st.intro || st.last) + '</div>' : '') +
      (!it.off && C.recentLeft(it, now) ? '<div class="small">최근 넣은 항목이라 앞으로 ' + C.recentLeft(it, now) + '일 동안 매 세션에 나옵니다.</div>' : '') +
      '<div class="card ctl-card"><div><b>학습에 포함</b><div class="small">' + (it.pending ? 'GPT가 고른 후보입니다. 켜면 학습에 들어가고, 필요 없으면 삭제하세요.' : '끄면 세션에 나오지 않습니다. 기록은 남고, 다시 켜면 이어서 학습합니다.') + '</div></div>' + switchHtml(it) + '</div>' +
      (S.confirmDel ? '<div class="row2"><button class="btn" data-act="del-cancel">취소</button><button class="btn danger" data-act="del-yes">기록까지 삭제</button></div>'
        : '<button class="btn danger" data-act="del" style="align-self:flex-start">이 항목 삭제</button>');
  }

  /* ---------- add ---------- */
  function addView() {
    var h = '<div class="notice">평소에는 GPT가 <b>add_items</b> 도구로 직접 등록합니다. 여기서는 같은 형식의 JSON을 붙여 넣어 등록할 수 있습니다.</div>';
    h += '<label class="small" for="add-json">add_items 형식의 JSON</label><textarea id="add-json" spellcheck="false" placeholder="{ &quot;source&quot;: {…}, &quot;items&quot;: […] }">' + esc(S.draftJson) + '</textarea>' +
      '<div class="row2"><button class="btn" data-act="example">예시 불러오기</button><button class="btn primary" data-act="check">확인하기</button></div>';
    if (S.flash) h += '<div class="notice">' + esc(S.flash) + '</div>';
    var p = S.preview;
    if (p) {
      if (p.errors.length || p.warnings.length) h += '<div class="msgs">' + p.errors.map(function (e) { return '<div class="e">' + esc(e) + '</div>'; }).join('') + p.warnings.map(function (w) { return '<div class="w">' + esc(w) + '</div>'; }).join('') + '</div>';
      if (p.items.length) {
        var n = p.items.filter(function (i) { return S.pick[i.id]; }).length;
        h += '<div class="small">학습에 넣을 항목을 고르세요. 체크하지 않은 항목은 저장하지 않습니다.</div><div class="list">' + p.items.map(function (i) {
          var old = S.byId[i.id];
          return '<label class="row pick-row"><input type="checkbox" id="pick-' + esc(i.id) + '" data-pick="' + esc(i.id) + '"' + (S.pick[i.id] ? ' checked' : '') + '>' +
            '<span class="pick-body"><span class="t"><b>' + esc(i.text) + '</b><span class="pill ' + (old ? '' : 'learning') + '">' + (old ? (old.pending ? '후보에서 학습으로' : '기존 항목에 합침') : '새 항목') + '</span></span><span class="m">' + esc(i.meaning_ko) + '</span>' +
            '<span class="s"><span>' + kindKo(i.kind) + '</span><span>예문 ' + i.examples.length + '</span><span>유의어 ' + i.synonyms.length + ' · 반의어 ' + i.antonyms.length + '</span>' + (i.pending ? '<span class="tag">GPT가 고른 후보</span>' : '') + (i.priority ? '<span>우선</span>' : '') + '</span></span></label>';
        }).join('') + '</div><button class="btn primary" data-act="save"' + (n && !S.busy ? '' : ' disabled') + '>' + (S.busy ? '저장하는 중…' : n ? '선택한 ' + n + '개 저장' : '저장할 항목을 고르세요') + '</button>';
      }
    }
    h += '<div class="card"><h2>붙여넣기용 GPT 지시문</h2><p class="small">MCP 연결을 쓸 수 없을 때(폰 등) ChatGPT의 맞춤 지침이나 대화 첫머리에 넣어 두면, "등록"이라고 말할 때 이 형식의 JSON을 출력합니다.</p>' +
      '<pre class="code" id="gpt-prompt">' + esc(GPT_PROMPT) + '</pre><button class="btn" data-act="copy">지시문 복사</button></div>';
    return h;
  }
  function check() {
    S.flash = '';
    S.preview = C.normalizePayload(S.draftJson, Date.now());
    setPicks(); render();
  }
  /** 사용자가 지목한 항목은 체크된 채로, GPT가 고른 후보는 체크를 푼 채로 보여 준다. */
  function setPicks() { S.pick = {}; if (S.preview) S.preview.items.forEach(function (i) { S.pick[i.id] = !i.pending; }); }
  /** 고른 항목을 서버에 등록한다. 서버가 같은 검사와 병합을 한 번 더 하고, 저장된 항목을 돌려준다. */
  async function save() {
    var p = S.preview; if (!p || !p.items.length || S.busy) return;
    var chosen = p.items.filter(function (i) { return S.pick[i.id]; });
    if (!chosen.length) return;
    var payload = {
      picked_by: 'user', // 이 화면에서 체크한 것은 사용자가 고른 것이다
      items: chosen.map(function (i) {
        return { kind: i.kind, text: i.text, ipa: i.ipa, meaning_ko: i.meaning_ko, note: i.note, examples: i.examples, synonyms: i.synonyms,
          antonyms: i.antonyms, wrong_meanings_ko: i.wrong_meanings_ko, wrong_fills: i.wrong_fills, priority: i.priority, source: i.src || undefined };
      })
    };
    S.busy = true; S.flash = ''; render();
    try {
      var r = await api('POST', '/api/add-items', payload);
      (r.items || []).forEach(function (it) {
        var k = S.items.findIndex(function (x) { return x.id === it.id; });
        if (k === -1) S.items.push(it); else S.items[k] = it;
        S.byId[it.id] = it;
      });
      var added = r.results.filter(function (x) { return x.status === 'created'; }).length, merged = r.results.length - added;
      S.preview = null; S.draftJson = '';
      S.flash = '새 항목 ' + added + '개를 등록했습니다' + (merged ? ', 기존 항목 ' + merged + '개에 내용을 합쳤습니다' : '') + '. 새 항목은 다음 세션부터 조금씩 나옵니다.';
    } catch (e) {
      if (e.code === 401) S.mode = 'nokey';
      else S.flash = '등록하지 못했습니다. ' + (e.code ? e.message : '연결을 확인한 뒤 다시 시도하세요.');
    }
    S.busy = false; render();
  }

  /* ---------- stats ---------- */
  function statsView() {
    var now = Date.now(), st = C.computeStats(S.items, S.sessions, now);
    var h = '<div class="tiles">' +
      '<div class="tile"><b>' + st.streak + '</b><span>연속 학습 일수</span></div>' +
      '<div class="tile"><b>' + st.today + '</b><span>오늘 본 카드</span></div>' +
      '<div class="tile"><b>' + (st.weekAcc == null ? '없음' : Math.round(st.weekAcc * 100) + '%') + '</b><span>최근 7일 퀴즈 정답률' + (st.weekQuiz ? ' (' + st.weekQuiz + '문제)' : '') + '</span></div>' +
      '<div class="tile"><b>' + st.due + '</b><span>복습할 항목</span></div></div>';
    h += '<div class="sec">단계별 항목 수 · 전체 ' + st.total + '개</div><div class="tiles">' +
      '<div class="tile"><b>' + st.by.queued + '</b><span>대기</span></div><div class="tile"><b>' + st.by.learning + '</b><span>익히는 중</span></div><div class="tile"><b>' + st.by.familiar + '</b><span>익숙함</span></div><div class="tile"><b>' + st.by.off + '</b><span>꺼짐</span></div></div>' +
      (st.by.pending ? '<div class="small">이와 별도로 확인을 기다리는 후보가 ' + st.by.pending + '개 있습니다.</div>' : '');
    h += '<div class="sec">자주 틀리는 항목</div>';
    h += st.weak.length ? '<div class="list">' + st.weak.map(function (i) {
      return '<button class="row" data-act="open-from-stats" data-id="' + esc(i.id) + '"><div class="t"><b>' + esc(i.text) + '</b><span class="s">틀림 ' + i.st.wrong + ' · 맞힘 ' + i.st.right + '</span></div><div class="m">' + esc(i.meaning_ko) + '</div></button>';
    }).join('') + '</div>' : '<div class="card empty">아직 틀린 항목이 없습니다.</div>';
    var recent = S.sessions.filter(function (s) { return s.ev && s.ev.length; }).sort(function (a, b) { return b.startedAt - a.startedAt; }).slice(0, 10);
    h += '<div class="sec">최근 세션</div>';
    h += recent.length ? '<div class="list">' + recent.map(function (s) {
      var q = 0, r = 0; s.ev.forEach(function (e) { if ((e.r === 1 || e.r === 0) && !e.x) { q++; r += e.r; } });
      return '<div class="row"><div class="t"><span>' + fmtTime(s.startedAt) + '</span><span class="s">카드 ' + s.ev.length + '장 · 퀴즈 ' + (q ? r + '/' + q : '없음') + '</span></div></div>';
    }).join('') + '</div>' : '<div class="card empty">아직 마친 세션이 없습니다.</div>';
    h += '<button class="btn" data-act="backup" style="align-self:flex-start">전체 기록 백업 받기 (JSON)</button>';
    return h;
  }

  /* ---------- 접속 키 ---------- */
  function keyView() {
    return '<div class="card"><h2>접속 키를 입력하세요</h2><p class="small">이 앱은 한 사람만 쓰도록 접속 키로 보호되어 있습니다. 배포할 때 받은 앱 주소(…/#key=…)로 열거나, 그 키를 아래에 붙여 넣으세요. 키는 이 브라우저에만 저장됩니다.</p>' +
      '<label class="small" for="key-input">접속 키</label><input id="key-input" class="key-input" type="password" autocomplete="off" spellcheck="false">' +
      (S.flash ? '<div class="msgs"><div class="e">' + esc(S.flash) + '</div></div>' : '') +
      '<button class="btn primary" data-act="key-save">확인</button></div>';
  }

  /* ---------- render & events ---------- */
  function showWarn() { var el = $('#warn'); if (el) { el.hidden = !S.warn; el.textContent = S.warn; } }
  function render() {
    document.querySelectorAll('.nav a').forEach(function (a) { if (a.getAttribute('href') === '#' + S.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    var m = $('#main'), h = '';
    if (S.note) h += '<div class="notice">' + esc(S.note) + '</div>';
    h += '<div class="notice warn" id="warn"' + (S.warn ? '' : ' hidden') + '>' + esc(S.warn) + '</div>';
    if (S.mode === 'loading') h += '<div class="card empty">불러오는 중…</div>';
    else if (S.mode === 'nokey') h += keyView();
    else if (S.mode === 'error') h += '<button class="btn primary" data-act="reload">다시 시도</button>';
    else if (S.view === 'study') h += S.sess ? sessionView() : studyHome();
    else if (S.view === 'items') h += itemsView();
    else if (S.view === 'add') h += addView();
    else h += statsView();
    m.innerHTML = h;
  }
  function route() {
    var v = (location.hash || '').replace('#', '');
    S.view = VIEWS.indexOf(v) !== -1 ? v : 'study';
    if (S.view !== 'items') { S.detail = null; S.confirmDel = false; S.delAsk = null; }
  }

  var ACT = {
    start: function () { startSession(); },
    flip: function () { S.sess.phase = 'back'; render(); },
    'intro-next': function () { record('intro'); advance(); },
    seen: function (el) { var v = el.getAttribute('data-v'); record(v === 'ok' ? 'seen_ok' : 'seen_new', { v: v }); advance(); },
    self: function (el) { var r = +el.getAttribute('data-r'); record(r ? 'right' : 'wrong', { r: r }); advance(); },
    answer: function (el) {
      var s = S.sess; if (s.answered != null) return;
      var i = +el.getAttribute('data-i'); s.answered = i;
      var ok = s.cur.options[i].ok; record(ok ? 'right' : 'wrong', { r: ok ? 1 : 0 }); render();
    },
    next: function () { advance(); },
    quit: function () { finish(); render(); },
    'close-sess': function () { S.sess = null; render(); },
    filter: function (el) { S.filter = el.getAttribute('data-f'); S.delAsk = null; render(); },
    open: function (el) { S.detail = el.getAttribute('data-id'); S.confirmDel = false; render(); window.scrollTo(0, 0); },
    'open-from-stats': function (el) { S.detail = el.getAttribute('data-id'); location.hash = '#items'; if (S.view === 'items') render(); },
    back: function () { S.detail = null; S.confirmDel = false; render(); },
    toggle: function (el) { var it = S.byId[el.getAttribute('data-id')]; if (!it) return; setItemState(it.id, { off: !it.off, pending: false }); render(); },
    'go-pending': function () { S.filter = 'pending'; S.detail = null; location.hash = '#items'; },
    'row-del': function (el) { S.delAsk = el.getAttribute('data-id'); render(); },
    'row-del-cancel': function () { S.delAsk = null; render(); },
    'row-del-yes': function (el) { removeItem(el.getAttribute('data-id')); S.delAsk = null; render(); },
    del: function () { S.confirmDel = true; render(); },
    'del-cancel': function () { S.confirmDel = false; render(); },
    'del-yes': function () { removeItem(S.detail); S.detail = null; S.confirmDel = false; render(); },
    reload: function () { S.mode = 'loading'; S.note = ''; render(); load(); },
    'key-save': function () {
      var v = ($('#key-input').value || '').trim().replace(/^.*key=/, '');
      if (!v) { S.flash = '키를 입력하세요.'; render(); return; }
      S.key = v; S.flash = ''; S.mode = 'loading'; render();
      api('GET', '/api/state').then(function (d) {
        try { localStorage.setItem(KEY_LS, v); } catch (e) { /* 이번 방문에만 쓴다 */ }
        S.items = d.items || []; S.sessions = d.sessions || []; reindex(); S.mode = 'ready'; render();
      }, function (e) { S.mode = 'nokey'; S.flash = e.code === 401 ? '키가 맞지 않습니다.' : '서버에 연결하지 못했습니다.'; render(); });
    },
    backup: function (el) {
      api('GET', '/api/export').then(function (d) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
        a.download = 'rewind-backup-' + C.dayKey(Date.now()) + '.json'; a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      }, function () { el.textContent = '백업을 받지 못했습니다. 다시 눌러 주세요'; });
    },
    example: function () { S.draftJson = JSON.stringify(EXAMPLE, null, 2); S.preview = null; check(); },
    check: check, save: save,
    copy: function (el) {
      var done = function (ok) { el.textContent = ok ? '복사했습니다' : '복사하지 못했습니다. 위 글을 직접 선택해 복사하세요'; };
      try { navigator.clipboard.writeText(GPT_PROMPT).then(function () { done(true); }, function () { done(false); }); } catch (e) { done(false); }
    }
  };
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]'); if (!el || el.disabled) return;
    var fn = ACT[el.getAttribute('data-act')]; if (fn) fn(el);
  });
  document.addEventListener('change', function (ev) {
    var id = ev.target.getAttribute && ev.target.getAttribute('data-pick');
    if (id) { S.pick[id] = ev.target.checked; render(); }
  });
  document.addEventListener('input', function (ev) {
    if (ev.target.id === 'add-json') S.draftJson = ev.target.value;
  });
  document.addEventListener('keydown', function (ev) {
    if (S.view !== 'study' || !S.sess || /^(TEXTAREA|INPUT)$/.test(ev.target.tagName) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (/^[1-4]$/.test(ev.key)) { var o = document.querySelector('.opt[data-i="' + (ev.key - 1) + '"]:not([disabled])'); if (o) { o.click(); ev.preventDefault(); } }
    else if (ev.key === 'Enter' && ev.target.tagName !== 'BUTTON' && ev.target.tagName !== 'A') { var p = document.querySelector('[data-primary]'); if (p) { p.click(); ev.preventDefault(); } }
  });
  window.addEventListener('hashchange', function () { var d = S.detail; route(); if (S.view === 'items' && d) S.detail = d; render(); window.scrollTo(0, 0); });

  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refreshIfIdle(); });
  window.__app = { S: S, render: render, load: load, busyWriting: busyWriting };
  init();
})();
