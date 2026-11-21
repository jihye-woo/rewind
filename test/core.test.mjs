import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Core as C } from '../shared/core.js';

const DAY = C.DAY, t0 = Date.parse('2026-11-15T04:00:00Z');
const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const example = JSON.parse(await readFile(new URL('../web/example.json', import.meta.url), 'utf8'));
const mk = (text, created, st, extra) => Object.assign(C.normalizePayload({ picked_by: 'user', items: [{ text, meaning_ko: text + ' 뜻', examples: [{ en: 'We ' + text + ' now.' }] }] }, created).items[0], { st }, extra || {});

test('등록 형식: 예시가 오류·경고 없이 4개 항목이 된다', () => {
  const n = C.normalizePayload('```json\n' + JSON.stringify(example) + '\n```', t0);
  assert.deepEqual(n.errors, []); assert.deepEqual(n.warnings, []);
  assert.deepEqual(n.items.map((i) => i.id), ['set-someone-up-with-something', 'bubbly', 'gorgeous', 'barkeep']);
  assert.ok(n.items.every((i) => !i.pending && !i.off));
});

test('등록 형식: 항목 ID, 빈칸 표시, 잘못된 입력', () => {
  assert.equal(C.slug('Set sb up with sth'), 'set-someone-up-with-something');
  assert.equal(C.exFill('Can you [set] me [up with] a drink?'), 'set … up with');
  assert.equal(C.autoMark('You look gorgeous tonight!', 'gorgeous'), 'You look [gorgeous] tonight!');
  assert.ok(C.normalizePayload('not json').errors.length);
  assert.match(C.normalizePayload({ items: [{ text: 'x' }] }).errors[0], /meaning_ko/);
});

test('후보: picked_by 가 user 가 아니면 꺼진 채 후보로 들어온다', () => {
  const cand = C.normalizePayload({ items: [{ text: "keep one's head down", meaning_ko: '조용히 지내다' }, { text: 'a cross word', meaning_ko: '화난 말', picked_by: 'user' }] }, t0).items;
  assert.deepEqual(cand.map((i) => [i.id, i.pending, i.off]), [['keep-one-s-head-down', true, true], ['a-cross-word', false, false]]);
  assert.deepEqual(C.buildSession(cand, [], t0).newIds, ['a-cross-word']);
  const named = C.normalizePayload({ picked_by: 'user', items: [{ text: "keep one's head down", meaning_ko: 'x' }] }, t0).items[0];
  const accepted = C.mergeItem(cand[0], named);
  assert.deepEqual([accepted.pending, accepted.off], [false, false]);
  assert.equal(C.mergeItem({ ...cand[1], off: true }, named).off, true, '사용자가 끈 항목은 다시 등록해도 꺼진 채');
});

test('병합: 학습 기록과 뜻은 유지하고 예문은 합친다', () => {
  const base = C.normalizePayload(example, t0).items[3];
  const old = { ...base, st: { h: 4, last: t0, seen: 3, right: 2, wrong: 0, recent: '11', sq: 0, intro: t0 } };
  const inc = C.normalizePayload({ picked_by: 'user', items: [{ text: 'Barkeep', meaning_ko: '다른 뜻', examples: [{ en: 'Hey, barkeep! Another round!' }, { en: 'Ask the barkeep.' }] }] }, t0).items[0];
  const m = C.mergeItem(old, inc);
  assert.equal(m.st.h, 4); assert.equal(m.meaning_ko, '바텐더, 술집 주인'); assert.equal(m.examples.length, 3);
});

test('간격: 방금 본 항목은 거의 늘지 않고, 반감기만큼 지나 맞히면 2배, 틀리면 절반', () => {
  let st = C.applyResult(null, 'intro', t0);
  st = C.applyResult(st, 'right', t0 + 60000); assert.ok(st.h < 1.01);
  st = C.applyResult(st, 'right', t0 + DAY); assert.ok(Math.abs(st.h - 2) < 0.01);
  st = C.applyResult(st, 'wrong', t0 + 2 * DAY); assert.ok(Math.abs(st.h - 1) < 0.01);
  assert.deepEqual([st.right, st.wrong, st.recent], [2, 1, '110']);
});

test('세션: 30일 시뮬레이션에서 카드 순서와 퀴즈 보기가 규칙을 지킨다', () => {
  const rnd = rng(42);
  const items = C.normalizePayload(example, t0).items.map((x) => structuredClone(x)), sessions = [];
  const sizes = [];
  for (let d = 0; d < 30; d++) {
    const now = t0 + d * DAY;
    if (d === 5) for (const w of ['hideout', 'call it a day', 'on the house', 'rain check', 'ballpark figure', 'swamped']) items.push(mk(w, now, null));
    const s = C.buildSession(items, sessions, now, rnd), byId = Object.fromEntries(items.map((i) => [i.id, i])), ev = [], introduced = new Set();
    s.cards.forEach((c, k) => {
      if (k) assert.notEqual(c.id, s.cards[k - 1].id, `d${d}: 같은 항목이 연달아 나옴`);
      const it = byId[c.id]; let kind; const e = { i: c.id };
      if (c.type === 'intro') { kind = 'intro'; e.t = 'intro'; introduced.add(c.id); }
      else if (c.type === 'expose') { kind = 'seen'; e.t = 'expose'; }
      else {
        if (s.newIds.includes(c.id)) assert.ok(introduced.has(c.id), '소개보다 퀴즈가 먼저 나옴');
        const q = C.resolveQuiz(it, items, rnd, c.prefer);
        if (!q) { kind = 'seen'; e.t = 'expose'; } // 보기를 만들 수 없으면 보고 익히기로
        else {
          assert.ok(['meaning', 'cloze', 'synonym'].includes(q.type), '스스로 채점하는 퀴즈는 내지 않는다: ' + q.type);
          assert.equal(q.options.length, 4); assert.equal(q.options.filter((o) => o.ok).length, 1); assert.equal(new Set(q.options.map((o) => o.label.toLowerCase())).size, 4);
          const ok = rnd() < 0.85; kind = ok ? 'right' : 'wrong'; e.t = q.type; e.r = ok ? 1 : 0;
        }
      }
      it.st = C.applyResult(it.st, kind, now + ev.length * 20000); ev.push(e);
    });
    sessions.push({ startedAt: now, ev }); sizes.push(s.cards.length);
  }
  assert.ok(Math.min(...sizes) >= 7 && Math.max(...sizes) <= C.CFG.maxCards, `세션 크기 ${Math.min(...sizes)}~${Math.max(...sizes)}`);
  assert.ok(items.every((i) => C.learned(i)));
  assert.equal(C.computeStats(items, sessions, t0 + 29 * DAY).streak, 30);
});

test('최근 넣은 항목: 일주일 동안 매 세션에 나오고, 오래된 복습 대상은 2자리를 지킨다', () => {
  const rnd = rng(7);
  const old = (h, ago) => ({ h, last: t0 - ago * DAY, intro: t0 - 40 * DAY, seen: 9, right: 4, wrong: 0, recent: '1111', sq: 0 });
  const items = [];
  for (let i = 0; i < 12; i++) items.push(mk('old' + i, t0 - 40 * DAY, old(20, 1)));
  for (let i = 0; i < 3; i++) items.push(mk('rec' + i, t0 - 2 * DAY, { h: 2, last: t0 - 0.2 * DAY, intro: t0 - 2 * DAY, seen: 4 + i, right: 1, wrong: 0, recent: '1', sq: 1 }));
  for (let i = 0; i < 6; i++) items.push(mk('new' + i, t0 - DAY, null));
  let s = C.buildSession(items, [], t0, rnd), ids = [...new Set(s.cards.map((c) => c.id))];
  assert.equal(s.newIds.filter((x) => x.startsWith('new')).length, 4);
  assert.ok(['rec0', 'rec1', 'rec2'].every((x) => ids.includes(x)));
  assert.ok(ids.length <= 10 && s.cards.length <= C.CFG.maxCards);
  const many = items.filter((i) => !i.id.startsWith('new'));
  for (let i = 0; i < 12; i++) many.push(mk('rr' + i, t0 - 3 * DAY, { h: 3, last: t0 - 0.1 * DAY, intro: t0 - 3 * DAY, seen: 5, right: 2, wrong: 0, recent: '11', sq: 0 }));
  many[0].st = old(4, 6); many[1].st = old(4, 5); many[2].st = old(4, 5);
  ids = [...new Set(C.buildSession(many, [], t0, rnd).cards.map((c) => c.id))];
  assert.equal(ids.filter((x) => x.startsWith('old')).length, 2); assert.equal(ids.length, 10);
  assert.ok(!C.isRecent(items[12], t0 + 6 * DAY));
});

test('끈 항목은 세션과 통계에서 빠진다', () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push(mk('w' + i, t0 - DAY, i < 6 ? { h: 2, last: t0 - 2 * DAY, intro: t0 - DAY, seen: 2, right: 1, wrong: 0, recent: '1', sq: 0 } : null, { off: i % 2 === 1 }));
  for (let k = 1; k <= 100; k++) C.buildSession(items, [], t0, rng(k)).cards.forEach((c) => assert.ok(!items.find((i) => i.id === c.id).off));
  const st = C.computeStats(items, [], t0);
  assert.equal(st.by.off, 5); assert.equal(st.by.off + st.by.queued + st.by.learning + st.by.familiar, 10);
});

test('아는지 묻지 않는다: 보고 익히기는 반감기를 바꾸지 않고, 퀴즈는 객관식만', () => {
  const now = 1794717000000;
  const st = C.applyResult(C.applyResult(null, 'intro', now), 'right', now + 2 * DAY);
  const seen = C.applyResult(st, 'seen', now + 5 * DAY);
  assert.equal(seen.h, st.h, '보고 익히기는 반감기를 그대로 둔다');
  assert.equal(seen.seen, st.seen + 1); assert.equal(seen.sq, st.sq + 1); assert.equal(seen.right, st.right);
  // 보기를 만들 재료가 없으면 null, 예전 기록의 prefer: 'recall' 도 객관식으로 바꾼다
  const lone = { id: 'x', kind: 'word', text: 'x', meaning_ko: '엑스', examples: [], st: { h: 20 } };
  assert.equal(C.resolveQuiz(lone, [lone], () => 0.1), null);
  const rich = { ...lone, wrong_meanings_ko: ['가', '나', '다'] };
  for (const h of [0.5, 5, 50]) {
    const q = C.resolveQuiz({ ...rich, st: { h } }, [rich], () => 0.1, h === 50 ? 'recall' : undefined);
    assert.equal(q.type, 'meaning');
  }
});
