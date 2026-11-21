import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/store-memory.mjs';
import * as service from '../server/service.mjs';
import { Core } from '../shared/core.js';
import * as cat from '../server/catalog.mjs';

const OWNER = { uid: 'owner', role: 'owner', name: '주인' };
const view = async (store, id, user = OWNER) => (await service.getState(store, user)).items.find((i) => i.id === id);

const item = (text, extra = {}) => ({ text, meaning_ko: text + ' 뜻', examples: [{ en: `I [${text}] it.` }, { en: `They [${text}] it.` }, { en: `We [${text}] it.` }], ...extra });

test('addItems: 새 항목, 병합, 후보, 후보 수락을 구분해 돌려준다', async () => {
  const store = createMemoryStore();
  let r = await service.addItems(store, { picked_by: 'user', source: { text: 'A line.' }, items: [item('call it a day')] }, 1000);
  assert.deepEqual(r.results.map((x) => [x.id, x.status, x.state]), [['call-it-a-day', 'created', 'queued']]);
  r = await service.addItems(store, { items: [item('lie low')] }, 2000); // picked_by 없음 → 후보
  assert.deepEqual(r.results.map((x) => [x.status, x.state]), [['candidate', 'candidate']]);
  r = await service.addItems(store, { picked_by: 'user', items: [item('lie low'), item('Call it a day', { examples: [{ en: 'Let\'s [call it a day].' }] })] }, 3000);
  assert.deepEqual(r.results.map((x) => x.status), ['accepted', 'merged']);
  const all = await cat.loadUnits(store);
  assert.equal(all.length, 2);
  assert.equal(all.find((i) => i.id === 'call-it-a-day').examples.length, 4);
  assert.equal(all.find((i) => i.id === 'call-it-a-day').createdAt, 1000, '처음 등록 시각을 유지');
  assert.equal(all.find((i) => i.id === 'lie-low').pending, false);
});

test('addItems: 잘못된 항목만 거절하고 나머지는 저장한다', async () => {
  const store = createMemoryStore();
  const r = await service.addItems(store, { picked_by: 'user', items: [{ text: 'no meaning' }, item('swamped')] }, 1);
  assert.equal(r.results.length, 1); assert.equal(r.errors.length, 1); assert.match(r.errors[0], /meaning_ko/);
  assert.equal((await cat.loadUnits(store)).length, 1);
});

test('findItems: 영어·뜻·유의어로 찾고, 빈 검색어는 최근 등록 순', async () => {
  const store = createMemoryStore();
  await service.addItems(store, { picked_by: 'user', items: [item('gorgeous', { meaning_ko: '아주 아름다운', synonyms: [{ text: 'stunning' }] })] }, 1);
  await service.addItems(store, { picked_by: 'user', items: [item('bubbly', { meaning_ko: '샴페인' })] }, 2);
  assert.deepEqual((await service.findItems(store, 'GORG')).map((x) => x.id), ['gorgeous']);
  assert.deepEqual((await service.findItems(store, '샴페인')).map((x) => x.id), ['bubbly']);
  assert.deepEqual((await service.findItems(store, 'stunning')).map((x) => x.id), ['gorgeous']);
  assert.deepEqual((await service.findItems(store, '')).map((x) => x.id), ['bubbly', 'gorgeous']);
  assert.deepEqual(await service.findItems(store, 'zzz'), []);
});

test('patchItem: 학습 상태만 바꾸고 값의 형식을 검사한다', async () => {
  const store = createMemoryStore();
  await service.addItems(store, { picked_by: 'user', items: [item('swamped')] }, 1);
  const st = { h: 1, last: 5, intro: 5, seen: 1, right: 0, wrong: 0, recent: '', sq: 1 };
  const out = await service.patchItem(store, OWNER, 'swamped', { st, off: true, text: 'hacked' });
  assert.deepEqual(out.st, st); assert.equal(out.off, true); assert.equal(out.text, 'swamped', '등록 내용은 바뀌지 않는다');
  assert.equal(await service.patchItem(store, OWNER, 'missing', { off: true }), null);
  await assert.rejects(service.patchItem(store, OWNER, 'swamped', { st: { h: -1 } }), service.InputError);
  await assert.rejects(service.patchItem(store, OWNER, 'swamped', {}), service.InputError);
  await assert.rejects(service.patchItem(store, OWNER, '../x', { off: true }), service.InputError);
});

test('putSession: 형식을 정리해 저장하고 최신순으로 돌려준다', async () => {
  const store = createMemoryStore();
  await service.putSession(store, OWNER, 's1794717536455', { startedAt: 1794717536455, endedAt: null, ev: [{ i: 'bubbly', t: 'intro', at: 1 }, { i: 'bubbly', t: 'meaning', at: 2, r: 1, junk: 'x' }] });
  await service.putSession(store, OWNER, 's1794717600000', { startedAt: 1794717600000, ev: [] });
  const s = await store.listSessions(10);
  assert.deepEqual(s.map((x) => x.id), ['s1794717600000', 's1794717536455']);
  assert.deepEqual(s[1].ev[1], { i: 'bubbly', t: 'meaning', at: 2, r: 1 });
  await assert.rejects(service.putSession(store, OWNER, 'bad', { startedAt: 1 }), service.InputError);
});

test('importAll: 프로토타입에서 내보낸 데이터를 등록 시각·학습 상태·꺼짐 그대로 되살린다', async () => {
  const { readFile } = await import('node:fs/promises');
  const data = JSON.parse(await readFile(new URL('../data/prototype-export.json', import.meta.url), 'utf8'));
  const store = createMemoryStore();
  let r = await service.importAll(store, data);
  assert.deepEqual(r, { items: { imported: 6, skipped: 0, rejected: [] }, sessions: { imported: 1, rejected: [] } });
  const items = (await service.getState(store, OWNER)).items, by = Object.fromEntries(items.map((i) => [i.id, i])); // 진도는 주인의 것으로 본다
  for (const src of data.items) {
    const got = by[src.id];
    for (const k of ['kind', 'text', 'meaning_ko', 'note', 'examples', 'synonyms', 'antonyms', 'wrong_meanings_ko', 'wrong_fills', 'priority', 'src', 'createdAt', 'st', 'off', 'pending']) {
      assert.deepEqual(got[k], src[k], `${src.id}.${k}`);
    }
  }
  assert.deepEqual(items.filter((i) => i.off).map((i) => i.id).sort(), ['barkeep', 'bubbly']);
  assert.equal((await store.listSessions(10))[0].n, 8);

  // 다시 넣으면 건너뛰고, 그 사이 쌓인 학습 상태를 덮어쓰지 않는다
  await service.patchItem(store, OWNER, 'gorgeous', { st: { ...by.gorgeous.st, seen: 9 } });
  r = await service.importAll(store, data);
  assert.deepEqual([r.items.imported, r.items.skipped], [0, 6]);
  assert.equal((await view(store, 'gorgeous')).st.seen, 9);
  r = await service.importAll(store, data, { overwrite: true });
  assert.equal(r.items.imported, 6); assert.equal((await view(store, 'gorgeous')).st.seen, 2);

  // 잘못된 항목은 그것만 거절한다
  r = await service.importAll(createMemoryStore(), { items: [{ text: 'x' }, { text: 'ok', meaning_ko: '뜻', st: { h: -3 } }, { text: 'fine', meaning_ko: '뜻' }], sessions: [{ id: 'bad' }] });
  assert.deepEqual([r.items.imported, r.items.rejected.length, r.sessions.rejected.length], [1, 2, 1]);
  await assert.rejects(service.importAll(createMemoryStore(), { nope: 1 }), service.InputError);
});

test('표현 → 뜻: 다른 뜻은 새 뜻, 활용형은 원형으로, 다른 뜻은 오답 보기에서 뺀다', async () => {
  const store = createMemoryStore();
  let r = await service.addItems(store, { picked_by: 'user', items: [item('apply', { meaning_ko: '지원하다', forms: ['applied', 'applies'], register: 'business' })] }, 1000);
  assert.deepEqual(r.results.map((x) => [x.id, x.status]), [['apply', 'created']]);
  // 활용형으로 들어와도 apply 에 모이고, 같은 뜻이면 합친다
  r = await service.addItems(store, { picked_by: 'user', items: [item('applied', { meaning_ko: '지원하다', examples: [{ en: 'She [applied] for the job.' }] })] }, 2000);
  assert.deepEqual(r.results.map((x) => [x.id, x.status]), [['apply', 'merged']]);
  // 다른 뜻은 새 뜻. 경고로 알려 준다
  r = await service.addItems(store, { picked_by: 'user', items: [item('apply', { meaning_ko: '적용하다', examples: [{ en: 'This rule [applies] to everyone.' }, { en: 'We [applied] the fix.' }] })] }, 3000);
  assert.deepEqual(r.results.map((x) => [x.id, x.status, x.sense]), [['apply~2', 'new_sense', 2]]);
  assert.match(r.warnings.join(' '), /새 뜻 apply~2/);
  // sense_id 로 그 뜻에 합친다 (뜻 풀이가 달라도)
  r = await service.addItems(store, { picked_by: 'user', items: [item('apply', { meaning_ko: '(규칙 등을) 적용하다', sense_id: 'apply~2', examples: [{ en: 'Does this [apply] to me?' }] })] }, 4000);
  assert.deepEqual(r.results.map((x) => [x.id, x.status]), [['apply~2', 'merged']]);
  // 한 호출 안에서 같은 표현의 두 뜻은 따로 들어간다
  r = await service.addItems(store, { picked_by: 'user', items: [item('pitch', { meaning_ko: '투구' }), item('pitch', { meaning_ko: '사업 제안' })] }, 5000);
  assert.deepEqual(r.results.map((x) => x.id), ['pitch', 'pitch~2']);

  const units = await cat.loadUnits(store), a1 = units.find((u) => u.id === 'apply');
  assert.deepEqual([a1.senseCount, a1.register, a1.forms.sort()], [2, 'business', ['applied', 'applies']]);
  assert.equal(units.find((u) => u.id === 'apply~2').examples.length, 3, '적용하다 예문 2개 + sense_id 로 합친 1개');
  // 뜻 고르기의 오답에 같은 표현의 다른 뜻(적용하다)은 나오지 않는다
  const others = [a1, units.find((u) => u.id === 'apply~2'), ...['x1', 'x2', 'x3'].map((t) => ({ id: t, exprId: t, kind: 'word', text: t, meaning_ko: t + ' 뜻', examples: [] }))];
  for (let i = 0; i < 20; i++) {
    const q = Core.buildQuiz(a1, 'meaning', others, Math.random);
    assert.ok(!q.options.some((o) => !o.ok && o.label.includes('적용')));
  }
  // 진도는 뜻마다 따로, 뜻을 지워도 다른 뜻은 남는다
  await service.patchItem(store, OWNER, 'apply~2', { st: { h: 2, last: 1, intro: 1, seen: 1, right: 1, wrong: 0, recent: '1', sq: 0 } });
  assert.equal((await service.getState(store, OWNER)).items.find((i) => i.id === 'apply').st, null);
  await service.deleteItem(store, 'apply');
  assert.deepEqual((await cat.loadUnits(store)).filter((u) => u.exprId === 'apply').map((u) => [u.id, u.senseCount]), [['apply~2', 1]]);
  assert.ok((await service.getState(store, OWNER)).items.find((i) => i.id === 'apply~2').st);
});

test('두 구조를 같이 읽는다: 예전 ITEM 행은 뜻 하나짜리 표현으로 보이고, 고치면 EXPR 로 옮겨진다', async () => {
  const store = createMemoryStore();
  await store.putItem({ id: 'swamped', kind: 'word', text: 'swamped', meaning_ko: '몹시 바쁜', examples: [{ en: "I'm [swamped]." }], synonyms: [], antonyms: [], wrong_meanings_ko: [], wrong_fills: [], st: { h: 3, last: 1, intro: 1, seen: 2, right: 1, wrong: 0, recent: '1', sq: 0 }, pending: false, off: false, createdAt: 1 });
  let units = await cat.loadUnits(store);
  assert.deepEqual(units.map((u) => [u.id, u.exprId, u.senseCount]), [['swamped', 'swamped', 1]]);
  assert.equal((await service.getState(store, OWNER)).items[0].st.h, 3, '주인의 예전 진도가 그대로 보인다');
  assert.equal(await store.getDoc('EXPR', 'swamped'), null);
  await service.addItems(store, { picked_by: 'user', items: [item('swamped', { meaning_ko: '몹시 바쁜' })] }, 2000);
  assert.ok(await store.getDoc('EXPR', 'swamped'), '쓰면 EXPR 로 옮겨진다');
  assert.ok(await store.getItem('swamped'), '예전 행은 되돌리기용으로 남는다');
  units = await cat.loadUnits(store);
  assert.equal(units.length, 1, '같은 항목이 두 번 보이지 않는다');
  assert.equal((await service.getState(store, OWNER)).items[0].st.h, 3);
  await service.deleteItem(store, 'swamped');
  assert.equal((await cat.loadUnits(store)).length, 0, '지우면 예전 행도 지워져 다시 나타나지 않는다');
});
