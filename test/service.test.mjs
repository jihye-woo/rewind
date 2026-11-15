import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/store-memory.mjs';
import * as service from '../server/service.mjs';

const item = (text, extra = {}) => ({ text, meaning_ko: text + ' 뜻', examples: [{ en: `I [${text}] it.` }, { en: `They [${text}] it.` }, { en: `We [${text}] it.` }], ...extra });

test('addItems: 새 항목, 병합, 후보, 후보 수락을 구분해 돌려준다', async () => {
  const store = createMemoryStore();
  let r = await service.addItems(store, { picked_by: 'user', source: { text: 'A line.' }, items: [item('call it a day')] }, 1000);
  assert.deepEqual(r.results.map((x) => [x.id, x.status, x.state]), [['call-it-a-day', 'created', 'queued']]);
  r = await service.addItems(store, { items: [item('lie low')] }, 2000); // picked_by 없음 → 후보
  assert.deepEqual(r.results.map((x) => [x.status, x.state]), [['candidate', 'candidate']]);
  r = await service.addItems(store, { picked_by: 'user', items: [item('lie low'), item('Call it a day', { examples: [{ en: 'Let\'s [call it a day].' }] })] }, 3000);
  assert.deepEqual(r.results.map((x) => x.status), ['accepted', 'merged']);
  const all = await store.listItems();
  assert.equal(all.length, 2);
  assert.equal(all.find((i) => i.id === 'call-it-a-day').examples.length, 4);
  assert.equal(all.find((i) => i.id === 'call-it-a-day').createdAt, 1000, '처음 등록 시각을 유지');
  assert.equal(all.find((i) => i.id === 'lie-low').pending, false);
});

test('addItems: 잘못된 항목만 거절하고 나머지는 저장한다', async () => {
  const store = createMemoryStore();
  const r = await service.addItems(store, { picked_by: 'user', items: [{ text: 'no meaning' }, item('swamped')] }, 1);
  assert.equal(r.results.length, 1); assert.equal(r.errors.length, 1); assert.match(r.errors[0], /meaning_ko/);
  assert.equal((await store.listItems()).length, 1);
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
  const out = await service.patchItem(store, 'swamped', { st, off: true, text: 'hacked' });
  assert.deepEqual(out.st, st); assert.equal(out.off, true); assert.equal(out.text, 'swamped', '등록 내용은 바뀌지 않는다');
  assert.equal(await service.patchItem(store, 'missing', { off: true }), null);
  await assert.rejects(service.patchItem(store, 'swamped', { st: { h: -1 } }), service.InputError);
  await assert.rejects(service.patchItem(store, 'swamped', {}), service.InputError);
  await assert.rejects(service.patchItem(store, '../x', { off: true }), service.InputError);
});

test('putSession: 형식을 정리해 저장하고 최신순으로 돌려준다', async () => {
  const store = createMemoryStore();
  await service.putSession(store, 's1794717536455', { startedAt: 1794717536455, endedAt: null, ev: [{ i: 'bubbly', t: 'intro', at: 1 }, { i: 'bubbly', t: 'meaning', at: 2, r: 1, junk: 'x' }] });
  await service.putSession(store, 's1794717600000', { startedAt: 1794717600000, ev: [] });
  const s = await store.listSessions(10);
  assert.deepEqual(s.map((x) => x.id), ['s1794717600000', 's1794717536455']);
  assert.deepEqual(s[1].ev[1], { i: 'bubbly', t: 'meaning', at: 2, r: 1 });
  await assert.rejects(service.putSession(store, 'bad', { startedAt: 1 }), service.InputError);
});
