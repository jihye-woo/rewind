/** 초대·손님·친구: 라우터 단에서 누가 무엇을 할 수 있는지. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../server/http.mjs';
import { createMemoryStore } from '../server/store-memory.mjs';
import { assets } from '../dist/web-assets.mjs';

const config = { appKey: 'app-key-123', mcpKey: 'mcp-key-456', publicRead: true, basePath: '/english' };
let clock = 1794717000000;
const mkDeps = () => ({ store: createMemoryStore(), config, assets, now: () => clock });
const req = (deps, method, path, { key, body } = {}) => route({
  method, path, headers: key ? { authorization: 'Bearer ' + key } : {}, body: body === undefined ? undefined : JSON.stringify(body),
}, deps).then((r) => ({ status: r.status, body: r.body ? JSON.parse(r.body) : null, raw: r }));
const OWNER_KEY = config.appKey;
const word = { picked_by: 'user', items: [{ text: 'on the house', meaning_ko: '무료로', examples: [{ en: 'Drinks are [on the house].' }] }] };
const st = { h: 1, last: 5, intro: 5, seen: 1, right: 0, wrong: 0, recent: '', sq: 1 };

async function invite(deps, name) {
  const inv = await req(deps, 'POST', '/api/invites', { key: OWNER_KEY, body: { name } });
  assert.equal(inv.status, 200); assert.match(inv.body.code, /^[A-Z2-9]{8}$/);
  const r = await req(deps, 'POST', '/api/invites/redeem', { body: { code: inv.body.code } });
  assert.equal(r.status, 200);
  return r.body;
}

test('화면은 서비스 경로를 base 로 쓴다', async () => {
  const page = await route({ method: 'GET', path: '/', headers: {} }, mkDeps());
  assert.match(page.body, /<base href="\/english\/">/);
  assert.match(page.headers['content-security-policy'], /base-uri 'self'/);
  assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(page.body, /<meta name="robots" content="noindex, nofollow">/);
  const deps = mkDeps();
  for (const p of ['/icon-192.png', '/manifest.webmanifest', '/api/state', '/api/me', '/nope']) {
    assert.equal((await route({ method: 'GET', path: p, headers: {} }, deps)).headers['x-robots-tag'], 'noindex, nofollow', p);
  }
});

test('손님은 주인의 화면을 읽기만 한다', async () => {
  const deps = mkDeps();
  await req(deps, 'POST', '/api/add-items', { key: OWNER_KEY, body: word });
  await req(deps, 'PATCH', '/api/items/on-the-house', { key: OWNER_KEY, body: { st } });
  await req(deps, 'PUT', '/api/sessions/s1794717000000', { key: OWNER_KEY, body: { startedAt: 1794717000000, ev: [] } });
  assert.equal((await req(deps, 'GET', '/api/me')).body.role, 'guest');
  const s = await req(deps, 'GET', '/api/state');
  assert.equal(s.status, 200); assert.equal(s.body.readOnly, true); assert.equal(s.body.items.length, 1);
  assert.deepEqual(s.body.items[0].st, st, '손님은 주인의 진도를 본다'); assert.equal(s.body.sessions.length, 1);
  // 친구의 진도는 손님에게 보이지 않는다
  const f = await invite(deps, '민수');
  await req(deps, 'PATCH', '/api/items/on-the-house', { key: f.token, body: { off: true } });
  assert.equal((await req(deps, 'GET', '/api/state')).body.items[0].off, false);
  assert.equal((await req(deps, 'GET', '/api/state', { key: f.token })).body.readOnly, false);
  for (const [m, p, body] of [['POST', '/api/add-items', word], ['PATCH', '/api/items/on-the-house', { off: true }], ['DELETE', '/api/items/on-the-house'],
    ['PUT', '/api/sessions/s1794717000000', { startedAt: 1 }], ['GET', '/api/export'], ['POST', '/api/invites', { self: true }], ['GET', '/api/people'], ['GET', '/api/traffic']]) {
    assert.equal((await req(deps, m, p, { body })).status, 401, `${m} ${p}`);
  }
  assert.equal((await req(deps, 'GET', '/api/state', { key: 'wrong' })).status, 401, '틀린 열쇠는 손님이 아니라 401');
  const closed = { ...mkDeps(), config: { ...config, publicRead: false } };
  assert.equal((await req(closed, 'GET', '/api/state')).status, 401, 'publicRead 를 끄면 손님은 못 본다');
  assert.equal((await req(closed, 'GET', '/api/me')).status, 401);
});

test('친구는 같은 단어장을 쓰고 진도는 따로 쌓는다', async () => {
  const deps = mkDeps();
  await req(deps, 'POST', '/api/add-items', { key: OWNER_KEY, body: word });
  await req(deps, 'PATCH', '/api/items/on-the-house', { key: OWNER_KEY, body: { st } });
  const f = await invite(deps, '민수');
  assert.deepEqual([f.me.role, f.me.name], ['friend', '민수']);
  const me = (await req(deps, 'GET', '/api/me', { key: f.token })).body;
  assert.equal(me.name, '민수');
  let s = (await req(deps, 'GET', '/api/state', { key: f.token })).body;
  assert.equal(s.items[0].st, null, '친구는 처음부터 시작');
  await req(deps, 'PATCH', '/api/items/on-the-house', { key: f.token, body: { off: true } });
  assert.equal((await req(deps, 'GET', '/api/state', { key: OWNER_KEY })).body.items[0].off, false, '친구가 끈 것은 주인에게 영향 없음');
  assert.deepEqual((await req(deps, 'GET', '/api/state', { key: OWNER_KEY })).body.items[0].st, st);
  // 친구도 등록한다. 모두에게 보인다
  const add = await req(deps, 'POST', '/api/add-items', { key: f.token, body: { picked_by: 'user', items: [{ text: 'bubbly', meaning_ko: '샴페인', examples: [{ en: 'Pop the [bubbly]!' }, { en: 'More [bubbly]?' }] }] } });
  assert.equal(add.status, 200);
  assert.equal((await req(deps, 'GET', '/api/state', { key: OWNER_KEY })).body.items.length, 2);
  // 친구가 못 하는 것
  assert.equal((await req(deps, 'POST', '/api/invites', { key: f.token, body: { name: '영희' } })).status, 403);
  for (const p of ['/api/people', '/api/traffic']) assert.equal((await req(deps, 'GET', p, { key: f.token })).status, 403);
  assert.equal((await req(deps, 'POST', '/api/import', { key: f.token, body: { items: [] } })).status, 403);
  // 친구의 새 기기: 같은 진도를 이어 쓴다
  const self = await req(deps, 'POST', '/api/invites', { key: f.token, body: { self: true } });
  const dev2 = (await req(deps, 'POST', '/api/invites/redeem', { body: { code: self.body.code } })).body;
  assert.equal(dev2.me.uid, f.me.uid);
  assert.equal((await req(deps, 'GET', '/api/state', { key: dev2.token })).body.items.find((i) => i.id === 'on-the-house').off, true);
});

test('초대 코드: 한 번만, 24시간 안에만', async () => {
  const deps = mkDeps();
  const inv = (await req(deps, 'POST', '/api/invites', { key: OWNER_KEY, body: { name: '영희' } })).body;
  assert.equal((await req(deps, 'POST', '/api/invites', { key: OWNER_KEY, body: {} })).status, 400, '이름이 필요');
  clock += 24 * 3600 * 1000 + 1;
  assert.equal((await req(deps, 'POST', '/api/invites/redeem', { body: { code: inv.code } })).status, 400, '기한 지남');
  const inv2 = (await req(deps, 'POST', '/api/invites', { key: OWNER_KEY, body: { name: '영희' } })).body;
  assert.equal((await req(deps, 'POST', '/api/invites/redeem', { body: { code: inv2.code } })).status, 200);
  assert.equal((await req(deps, 'POST', '/api/invites/redeem', { body: { code: inv2.code } })).status, 400, '두 번째');
  assert.equal((await req(deps, 'POST', '/api/invites/redeem', { body: { code: 'ABCD2345' } })).status, 400);
  const people = (await req(deps, 'GET', '/api/people', { key: OWNER_KEY })).body;
  assert.deepEqual(people.users.map((u) => u.name), ['영희']);
  assert.equal(people.invites.length, 2); assert.ok(!JSON.stringify(people).includes(inv2.code), '목록에 코드는 나오지 않는다');
});

test('접속 끊기: 그 사람의 열쇠와 MCP 주소가 막히고 기록은 남는다', async () => {
  const deps = mkDeps();
  await req(deps, 'POST', '/api/add-items', { key: OWNER_KEY, body: word });
  const f = await invite(deps, '민수');
  const mcp = (await req(deps, 'POST', '/api/me/mcp', { key: f.token })).body.path;
  assert.match(mcp, /^mcp\/[\w-]{20,}$/);
  const ping = () => route({ method: 'POST', path: '/' + mcp, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_items', arguments: {} } }) }, deps);
  assert.equal((await ping()).status, 200);
  assert.equal((await req(deps, 'DELETE', '/api/users/' + f.me.uid, { key: OWNER_KEY })).status, 204);
  assert.equal((await req(deps, 'GET', '/api/state', { key: f.token })).status, 401);
  assert.equal((await ping()).status, 404);
  assert.equal((await req(deps, 'GET', '/api/people', { key: OWNER_KEY })).body.users[0].revokedAt, clock);
  // 새 MCP 키를 만들면 예전 것은 막힌다 (주인)
  const k1 = (await req(deps, 'POST', '/api/me/mcp', { key: OWNER_KEY })).body.path;
  const k2 = (await req(deps, 'POST', '/api/me/mcp', { key: OWNER_KEY })).body.path;
  const call = (p) => route({ method: 'POST', path: '/' + p, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }, deps);
  assert.equal((await call(k1)).status, 404); assert.equal((await call(k2)).status, 200);
  assert.equal((await call('mcp/' + config.mcpKey)).status, 200, '배포 때 만든 MCP 키는 그대로');
});
