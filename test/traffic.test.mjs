/** IP별 접속 기록: 라우터의 분류, 키가 기록에 남지 않는지, 기록이 실패해도 응답이 나가는지. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../server/http.mjs';
import { createMemoryStore, createMemoryTraffic } from '../server/store-memory.mjs';
import { assets } from '../dist/web-assets.mjs';

const config = { appKey: 'app-key-123', mcpKey: 'mcp-key-456', publicRead: true };
let clock = 1794717000000;
const mkDeps = (traffic = createMemoryTraffic()) => ({ store: createMemoryStore(), traffic, config, assets, now: () => clock });
const call = (deps, ip, method, path, headers = {}, body) => route({ method, path, headers, ip, body: body && JSON.stringify(body) }, deps);
const app = { authorization: 'Bearer ' + config.appKey };

test('요청 종류별로 IP마다 센다', async () => {
  const deps = mkDeps();
  await call(deps, '1.1.1.1', 'GET', '/', { 'user-agent': 'Safari' });
  await call(deps, '1.1.1.1', 'GET', '/icon-192.png'); // 아이콘은 세지 않는다
  await call(deps, '1.1.1.1', 'GET', '/api/state', app);
  clock += 1000;
  await call(deps, '1.1.1.1', 'GET', '/api/state', app);
  await call(deps, '2.2.2.2', 'GET', '/api/state', { authorization: 'Bearer wrong' });
  await call(deps, '2.2.2.2', 'GET', '/wp-login.php');
  await call(deps, '3.3.3.3', 'POST', '/mcp/' + config.mcpKey, {}, { jsonrpc: '2.0', id: 1, method: 'ping' });
  await call(deps, '4.4.4.4', 'POST', '/mcp/guess', {}, { jsonrpc: '2.0', id: 1, method: 'ping' });

  const r = await call(deps, '1.1.1.1', 'GET', '/api/traffic', app);
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.you, '1.1.1.1'); assert.equal(d.enabled, true);
  const by = Object.fromEntries(d.visits.map((v) => [v.ip, v]));
  assert.equal(by['1.1.1.1'].n_page, 1);
  assert.equal(by['1.1.1.1'].n_app, 3, '/api/traffic 호출도 센다');
  assert.equal(by['1.1.1.1'].firstKey_app, 1794717000000, '처음 키를 쓴 시각은 바뀌지 않는다');
  assert.equal(by['1.1.1.1'].ua, '');
  assert.equal(by['2.2.2.2'].n_denied, 1); assert.equal(by['2.2.2.2'].n_other, 1); assert.equal(by['2.2.2.2'].lastPath, '/wp-login.php');
  assert.equal(by['2.2.2.2'].firstKey_app, undefined);
  assert.equal(by['3.3.3.3'].n_mcp, 1); assert.ok(by['3.3.3.3'].firstKey_mcp);
  assert.equal(by['4.4.4.4'].n_denied, 1);
  assert.ok(!JSON.stringify(d).includes(config.mcpKey) && !JSON.stringify(d).includes('guess'), 'MCP 경로(키)는 기록에 남기지 않는다');
});

test('접속 기록은 앱 키로만 본다', async () => {
  const deps = mkDeps();
  assert.equal((await call(deps, '1.1.1.1', 'GET', '/api/traffic')).status, 401, '손님');
  assert.equal((await call(deps, '1.1.1.1', 'GET', '/api/traffic', { authorization: 'Bearer ' + config.mcpKey })).status, 401);
});

test('기록이 실패해도 응답은 그대로 나간다', async () => {
  const deps = mkDeps({ async recordVisit() { throw new Error('throttled'); }, async listVisits() { return []; } });
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal((await call(deps, '1.1.1.1', 'GET', '/api/state', app)).status, 200);
    assert.equal((await call(deps, '1.1.1.1', 'GET', '/')).status, 200);
  } finally { console.warn = warn; }
});

test('traffic 이 없거나 IP를 모르면 기록하지 않는다', async () => {
  const deps = mkDeps(); delete deps.traffic;
  const r = await call(deps, '1.1.1.1', 'GET', '/api/traffic', app);
  assert.deepEqual(JSON.parse(r.body), { you: '1.1.1.1', enabled: false, visits: [] });
  const t = createMemoryTraffic(), deps2 = mkDeps(t);
  await call(deps2, undefined, 'GET', '/api/state', app);
  assert.deepEqual(await t.listVisits(), []);
});
