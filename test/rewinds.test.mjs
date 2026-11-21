/** rewinds: 진단 → 대상 → 한 번에 고치기 → 기록 → 되돌리기. 진도와 원문은 건드리지 않는다 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/store-memory.mjs';
import * as service from '../server/service.mjs';
import * as rewinds from '../server/rewinds.mjs';
import * as cat from '../server/catalog.mjs';
import * as users from '../server/users.mjs';
import { route } from '../server/http.mjs';
import { assets } from '../dist/web-assets.mjs';
import { Core } from '../shared/core.js';

const OWNER = { uid: 'owner', role: 'owner', name: '주인' };
const NOW = Date.parse('2026-11-22T00:00:00Z');
const st = (seen, h) => ({ h, last: 1, intro: seen * 10, seen, right: 1, wrong: 0, recent: '1', sq: 0 });
async function seed() {
  const store = createMemoryStore();
  await service.addItems(store, { picked_by: 'user', source: { text: 'Kayla kept her head down.', ko: '케일라는 묵묵히 일했다.' }, items: [
    { text: 'keep one\'s head down', meaning_ko: '눈에 띄지 않게 묵묵히 하다', examples: [{ en: 'Just [keep your head down].', ko: '그냥 조용히 해.' }] },
    { text: 'gorgeous', kind: 'word', ipa: '/ˈɡɔːrdʒəs/', meaning_ko: '아주 아름다운', register: 'casual',
      examples: Array.from({ length: 9 }, (_, i) => ({ en: `View ${i} is [gorgeous].`, ko: `${i}번 경치가 멋지다.` })),
      wrong_meanings_ko: ['거대한', '비싼', '너그러운'], wrong_fills: ['gorgeously', 'gorge', 'gory'], collocations: ['gorgeous view'] },
  ] }, NOW - 5 * 86400000);
  return store;
}

test('진단: 모자란 칸과 너무 많이 본 예문, 우선순위', async () => {
  const store = await seed();
  // gorgeous 의 0번 예문을 120번 보여 줬다
  const key = Core.exKey('View 0 is [gorgeous].');
  await service.putSession(store, OWNER, 's1794700000000', { startedAt: 1794700000000, ev: Array.from({ length: 120 }, (_, i) => ({ i: 'gorgeous', t: 'meaning', at: i, ex: key })) });
  const t = await rewinds.targets(store, {}, NOW);
  assert.equal(t.today, '2026-11-22');
  assert.equal(rewinds.kstDate(Date.parse('2026-11-21T16:30:00Z')), '2026-11-22', '한국은 이미 다음 날');
  const g = t.targets.find((x) => x.sense_id === 'gorgeous'), k = t.targets.find((x) => x.sense_id === 'keep-one-s-head-down');
  assert.deepEqual(g.overexposed.map((e) => [e.key, e.shown]), [[key, 120]]);
  assert.equal(g.content.examples.find((e) => e.key === key).shown, 120);
  assert.ok(g.gaps.some((x) => x.code === 'overexposed_examples'));
  assert.ok(!g.gaps.some((x) => ['few_examples', 'no_register', 'no_ipa', 'weak_wrong_meanings'].includes(x.code)));
  assert.ok(['no_register', 'few_examples', 'no_contrasts', 'no_trends', 'weak_wrong_meanings'].every((c) => k.gaps.some((x) => x.code === c)));
  assert.equal(k.content.source.text, 'Kayla kept her head down.');
  assert.deepEqual((await rewinds.targets(store, { ids: ['gorgeous'] }, NOW)).targets.map((x) => x.sense_id), ['gorgeous']);
});

test('한 번에 고치기: 칸을 채우고 예문을 바꾸되, 진도·원문은 그대로', async () => {
  const store = await seed();
  await service.patchItem(store, OWNER, 'gorgeous', { st: st(5, 4) });
  const before = (await service.getState(store, OWNER)).items.find((i) => i.id === 'gorgeous');
  const k0 = Core.exKey('View 0 is [gorgeous].'), k1 = Core.exKey('View 1 is [gorgeous].');
  const r = await rewinds.apply(store, { note: '테스트', updates: [
    { sense_id: 'gorgeous', set: { contrasts: [{ text: 'beautiful', when_ko: '더 일반적', example: { en: 'A beautiful day.', ko: '아름다운 날.' } }],
      trends: [{ en: 'The new phone looks gorgeous.', ko: '새 폰 멋지다.', topic: '신제품', source: 'News', url: 'https://example.com/a', date: '2026-11-20' }] },
      replace_examples: [{ key: k0, en: 'Your dress is gorgeous.', ko: '드레스 멋지다.' }], remove_examples: [k1],
      add_examples: Array.from({ length: 6 }, (_, i) => ({ en: `New ${i} looks gorgeous.`, ko: '' })) },
    { sense_id: 'keep-one-s-head-down', set: { register: 'Casual', collocations: ['just keep your head down'] } },
    { sense_id: 'nope', set: { note: 'x' } },
  ] }, NOW);
  assert.match(r.run_id, /^r\d+$/);
  assert.deepEqual(r.errors, ['nope: 없는 뜻입니다.']);
  assert.match(r.warnings.join(' '), /12개까지/);
  const g = r.results.find((x) => x.sense_id === 'gorgeous');
  assert.ok(g.change_id); assert.ok(g.changes.includes('예문 1개 바꿈') && g.changes.includes('예문 1개 지움'));
  const after = (await service.getState(store, OWNER)).items.find((i) => i.id === 'gorgeous');
  assert.equal(after.examples.length, 12);
  assert.ok(after.examples.some((e) => e.en === 'Your dress is [gorgeous].'), '바꾼 예문에 [ ] 를 자동으로 붙인다');
  assert.ok(!after.examples.some((e) => e.en.startsWith('View 1')));
  assert.equal(after.trends[0].en, 'The new phone looks [gorgeous].');
  assert.deepEqual(after.contrasts[0], { text: 'beautiful', when_ko: '더 일반적', en: 'A beautiful day.', ko: '아름다운 날.' });
  assert.deepEqual(after.st, before.st, '진도는 그대로');
  const k = (await service.getState(store, OWNER)).items.find((i) => i.id === 'keep-one-s-head-down');
  assert.equal(k.register, 'casual'); assert.equal(k.src.text, 'Kayla kept her head down.', '원문은 그대로');
  // 고친 뜻은 대상에서 빠지거나 뒤로 간다
  const t = await rewinds.targets(store, {}, NOW);
  assert.ok(!t.targets.find((x) => x.sense_id === 'gorgeous') || !t.targets.find((x) => x.sense_id === 'gorgeous').gaps.some((x) => ['no_contrasts', 'no_trends'].includes(x.code)));
});

test('합치기: 사람마다 학습량이 많은 쪽 진도, 활용형은 원형에, 되돌리면 원래대로', async () => {
  const store = createMemoryStore();
  await service.addItems(store, { picked_by: 'user', items: [
    { text: 'apply', meaning_ko: '지원하다', examples: [{ en: 'I [applied] for it.' }] },
    { text: 'applies', meaning_ko: '지원하다(3인칭)', examples: [{ en: 'He [applies] every year.' }] },
  ] }, NOW);
  const inv = await users.createInvite(store, OWNER, { name: '민수' }, NOW), f = await users.redeemInvite(store, inv.code, NOW);
  await service.patchItem(store, OWNER, 'apply', { st: st(2, 1) }); await service.patchItem(store, OWNER, 'applies', { st: st(6, 3) });
  await service.patchItem(store, f.user, 'apply', { st: st(4, 2) }); await service.patchItem(store, f.user, 'applies', { st: st(1, 9) });
  const r = await rewinds.apply(store, { updates: [{ sense_id: 'applies', merge_into: 'apply' }] }, NOW);
  assert.equal(r.results[0].merged_into, 'apply');
  const units = await cat.loadUnits(store);
  assert.deepEqual(units.map((u) => u.id), ['apply']);
  assert.ok(units[0].forms.includes('applies')); assert.equal(units[0].examples.length, 2);
  const mine = (await service.getState(store, OWNER)).items[0].st, theirs = (await service.getState(store, f.user)).items[0].st;
  assert.equal(mine.seen, 6, '주인: 본 횟수가 많은 applies 쪽'); assert.equal(mine.intro, 20, '처음 학습 시각은 이른 쪽');
  assert.equal(theirs.seen, 4, '친구: apply 쪽이 더 많이 봤다');
  // 되돌리기
  const h = await rewinds.history(store);
  assert.equal(h.runs[0].run_id, r.run_id);
  const u = await rewinds.undo(store, { run_id: r.run_id }, NOW + 1);
  assert.equal(u.undone.length, 1);
  assert.deepEqual((await cat.loadUnits(store)).map((x) => x.id).sort(), ['applies', 'apply']);
  assert.equal((await service.getState(store, OWNER)).items.find((i) => i.id === 'apply').st.seen, 2, '진도도 원래대로');
  await assert.rejects(rewinds.undo(store, { run_id: r.run_id }), service.InputError, '두 번 되돌리지 않는다');
});

test('되돌리기: 그 뒤에 다시 고친 표현은 덮어쓰지 않는다', async () => {
  const store = await seed();
  const r1 = await rewinds.apply(store, { updates: [{ sense_id: 'gorgeous', set: { note: '첫 번째' } }] }, NOW);
  await rewinds.apply(store, { updates: [{ sense_id: 'gorgeous', set: { note: '두 번째' } }] }, NOW + 1);
  const u = await rewinds.undo(store, { run_id: r1.run_id }, NOW + 2);
  assert.equal(u.undone.length, 0); assert.match(u.skipped[0].reason, /다시 바뀐/);
  assert.equal((await cat.getUnit(store, 'gorgeous')).note, '두 번째');
});

test('MCP: 대상 보기는 누구나, 고치기·되돌리기는 주인만', async () => {
  const store = await seed();
  const deps = { store, config: { appKey: 'a', mcpKey: 'owner-mcp', publicRead: true }, assets, now: () => NOW };
  const inv = await users.createInvite(store, OWNER, { name: '민수' }, NOW), f = await users.redeemInvite(store, inv.code, NOW);
  const friendMcp = await users.newMcpKey(store, f.user, NOW);
  const call = async (key, name, args) => JSON.parse((await route({ method: 'POST', path: '/mcp/' + key, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }, deps)).body).result;
  const list = JSON.parse((await route({ method: 'POST', path: '/mcp/owner-mcp', headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }, deps)).body).result.tools.map((t) => t.name);
  assert.deepEqual(list, ['add_items', 'find_items', 'rewinds_targets', 'rewinds_apply', 'rewinds_history', 'rewinds_undo']);
  assert.ok((await call(friendMcp, 'rewinds_targets', {})).structuredContent.targets.length);
  const denied = await call(friendMcp, 'rewinds_apply', { updates: [{ sense_id: 'gorgeous', set: { note: 'x' } }] });
  assert.equal(denied.isError, true);
  const ok = await call('owner-mcp', 'rewinds_apply', { updates: [{ sense_id: 'gorgeous', set: { note: '주인이 고침' } }] });
  assert.match(ok.content[0].text, /1개 고침/);
  assert.equal((await cat.getUnit(store, 'gorgeous')).note, '주인이 고침');
});
