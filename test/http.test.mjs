import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../server/http.mjs';
import { createMemoryStore } from '../server/store-memory.mjs';
import { assets } from '../dist/web-assets.mjs';

const config = { appKey: 'app-key-123', mcpKey: 'mcp-key-456' };
const mkDeps = () => ({ store: createMemoryStore(), config, assets, now: () => 1794717000000 });
const call = (deps, method, path, { body, headers = {}, auth = true } = {}) => route({
  method, path, headers: { ...(auth && path.startsWith('/api/') ? { authorization: 'Bearer ' + config.appKey } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
}, deps);
const payload = { picked_by: 'user', items: [{ text: 'bubbly', meaning_ko: '샴페인', examples: [{ en: 'Pop the [bubbly]!' }, { en: 'Some [bubbly]?' }] }] };

test('앱 화면과 아이콘은 인증 없이 내려 준다', async () => {
  const deps = mkDeps();
  const page = await call(deps, 'GET', '/');
  assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/); assert.match(page.body, /re:wind/);
  assert.ok(page.headers['content-security-policy']);
  assert.ok(!page.body.includes(config.appKey), '화면에 키가 들어 있으면 안 된다');
  const icon = await call(deps, 'GET', '/icon-192.png');
  assert.equal(icon.status, 200); assert.equal(icon.base64, true);
  assert.equal(JSON.parse((await call(deps, 'GET', '/manifest.webmanifest')).body).short_name, 'Rewind');
  assert.equal((await call(deps, 'GET', '/nope')).status, 404);
});

test('앱 API는 접속 키가 맞아야 한다', async () => {
  const deps = mkDeps();
  assert.equal((await call(deps, 'GET', '/api/state', { auth: false })).status, 401, 'publicRead 가 꺼져 있으면 손님도 막는다');
  assert.equal((await call(deps, 'GET', '/api/state', { auth: false, headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await call(deps, 'GET', '/api/state', { auth: false, headers: { authorization: 'Bearer ' + config.mcpKey } })).status, 401, 'MCP 키로는 앱 API를 쓸 수 없다');
  assert.equal((await call(deps, 'GET', '/api/state')).status, 200);
});

test('등록 → 상태 변경 → 세션 저장 → 조회 → 백업 → 삭제', async () => {
  const deps = mkDeps();
  let r = await call(deps, 'POST', '/api/add-items', { body: payload });
  assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).results[0].status, 'created');
  const st = { h: 1, last: 10, intro: 10, seen: 1, right: 0, wrong: 0, recent: '', sq: 1 };
  r = await call(deps, 'PATCH', '/api/items/bubbly', { body: { st } });
  assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body).item.st, st);
  assert.equal((await call(deps, 'PATCH', '/api/items/none', { body: { off: true } })).status, 404);
  assert.equal((await call(deps, 'PATCH', '/api/items/bubbly', { body: { st: 'x' } })).status, 400);
  assert.equal((await call(deps, 'PUT', '/api/sessions/s1794717536455', { body: { startedAt: 1794717536455, ev: [{ i: 'bubbly', t: 'intro', at: 1 }] } })).status, 200);
  const state = JSON.parse((await call(deps, 'GET', '/api/state')).body);
  assert.equal(state.items.length, 1); assert.equal(state.sessions.length, 1); assert.equal(state.sessions[0].n, 1);
  assert.equal(JSON.parse((await call(deps, 'GET', '/api/export')).body).items.length, 1);
  assert.equal((await call(deps, 'DELETE', '/api/items/bubbly')).status, 204);
  assert.equal(JSON.parse((await call(deps, 'GET', '/api/state')).body).items.length, 0);
  const bad = await route({ method: 'POST', path: '/api/add-items', headers: { authorization: 'Bearer ' + config.appKey }, body: '{not json' }, deps);
  assert.equal(bad.status, 400);
});

test('MCP 엔드포인트: 키, 메서드, 버전 헤더, 알림', async () => {
  const deps = mkDeps();
  const rpc = (body, path = '/mcp/' + config.mcpKey, headers = {}) => call(deps, 'POST', path, { body, headers });
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, '/mcp/wrong')).status, 404);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, '/mcp/' + config.appKey)).status, 404, '앱 키로는 MCP를 쓸 수 없다');
  assert.equal((await call(deps, 'GET', '/mcp/' + config.mcpKey)).status, 405);
  assert.equal((await call(deps, 'DELETE', '/mcp/' + config.mcpKey)).status, 405);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, undefined, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
  const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202); assert.equal(note.body, '');
  const init = JSON.parse((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })).body);
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.ok(init.result.capabilities.tools);
  const newer = JSON.parse((await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } })).body);
  assert.equal(newer.result.protocolVersion, '2025-11-25', '모르는 버전이면 서버가 아는 최신 버전을 제안');
  const unknown = JSON.parse((await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } })).body);
  assert.equal(unknown.error.code, -32602);
  assert.equal(JSON.parse((await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).body).error.code, -32601);
  assert.equal((await rpc([{ jsonrpc: '2.0', id: 5, method: 'ping' }])).status, 400, '묶음 요청은 받지 않는다');
});

test('publicRead: 키 없이는 상태 조회만 읽기 전용으로 되고, 쓰기·백업·틀린 키는 막힌다', async () => {
  const deps = { ...mkDeps(), config: { ...config, publicRead: true } };
  await call(deps, 'POST', '/api/add-items', { body: payload });
  const ro = await call(deps, 'GET', '/api/state', { auth: false });
  assert.equal(ro.status, 200);
  const st = JSON.parse(ro.body);
  assert.equal(st.readOnly, true); assert.equal(st.items.length, 1);
  assert.equal(JSON.parse((await call(deps, 'GET', '/api/state')).body).readOnly, false, '키가 맞으면 쓰기 가능');
  assert.equal((await call(deps, 'GET', '/api/state', { auth: false, headers: { authorization: 'Bearer wrong' } })).status, 401, '틀린 키는 읽기 전용으로 넘어가지 않는다');
  assert.equal((await call(deps, 'GET', '/api/export', { auth: false })).status, 401);
  assert.equal((await call(deps, 'POST', '/api/add-items', { auth: false, body: payload })).status, 401);
  assert.equal((await call(deps, 'PATCH', '/api/items/bubbly', { auth: false, body: { off: true } })).status, 401);
  assert.equal((await call(deps, 'DELETE', '/api/items/bubbly', { auth: false })).status, 401);
  assert.equal((await call(deps, 'PUT', '/api/sessions/s1', { auth: false, body: { startedAt: 1, ev: [] } })).status, 401);
  assert.equal((await call(deps, 'POST', '/api/import', { auth: false, body: { items: [] } })).status, 401);
});
