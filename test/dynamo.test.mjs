/**
 * DynamoDB 저장소와, 배포될 Lambda 묶음(dist/lambda/index.mjs)을 로컬 DynamoDB 흉내(dynalite)에 붙여 시험한다.
 * 실제 AWS 에는 접속하지 않는다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dynalite from 'dynalite';
import { DynamoDBClient, CreateTableCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { createDynamoStore, createDynamoTraffic } from '../server/store-dynamo.mjs';
import * as service from '../server/service.mjs';

const OWNER = { uid: 'owner', role: 'owner', name: '주인' };

let server, endpoint, client;
const TABLE = 'rewind-test';

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  client = new DynamoDBClient({ endpoint, region: 'ap-northeast-2', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } });
  await client.send(new CreateTableCommand({
    TableName: TABLE, BillingMode: 'PROVISIONED', ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
  }));
});
after(async () => { client.destroy(); await new Promise((ok) => server.close(ok)); });

test('DynamoDB 저장소: 등록, 상태 변경, 세션, 삭제', async () => {
  const store = createDynamoStore({ tableName: TABLE, client });
  await service.addItems(store, { picked_by: 'user', source: { text: 'Pop the bubbly!' }, items: [
    { text: 'bubbly', meaning_ko: '샴페인', note: '', examples: [{ en: 'Pop the [bubbly]!', ko: '' }], antonyms: [] },
    { text: 'gorgeous', meaning_ko: '아주 아름다운' },
  ] }, 1000);
  let items = await store.listItems();
  assert.deepEqual(items.map((i) => i.id).sort(), ['bubbly', 'gorgeous']);
  assert.equal(items.find((i) => i.id === 'bubbly').st, null);

  const st = { h: 1.5, last: 20, intro: 10, seen: 2, right: 1, wrong: 0, recent: '1', sq: 0 };
  const patched = await service.patchItem(store, OWNER, 'bubbly', { st });
  assert.deepEqual(patched.st, st); assert.equal(patched.text, 'bubbly'); assert.equal(patched.examples.length, 1);
  assert.equal(await service.patchItem(store, OWNER, 'nothing', { off: true }), null);
  await service.patchItem(store, OWNER, 'gorgeous', { off: true, pending: false });
  assert.equal((await service.getState(store, OWNER)).items.find((i) => i.id === 'gorgeous').off, true);

  // 학습 상태를 바꾼 뒤 같은 항목을 다시 등록해도 상태가 남는다
  await service.addItems(store, { picked_by: 'user', items: [{ text: 'bubbly', meaning_ko: 'x', examples: [{ en: 'Some [bubbly]?' }] }] }, 2000);
  const merged = (await service.getState(store, OWNER)).items.find((i) => i.id === 'bubbly');
  assert.deepEqual(merged.st, st); assert.equal(merged.examples.length, 2);

  for (const t of [1794717536455, 1794717600000, 1794717700000]) await service.putSession(store, OWNER, 's' + t, { startedAt: t, ev: [{ i: 'bubbly', t: 'intro', at: t }] });
  assert.deepEqual((await store.listSessions(2)).map((s) => s.startedAt), [1794717700000, 1794717600000]);

  await service.deleteItem(store, 'gorgeous');
  assert.deepEqual((await store.listItems()).map((i) => i.id), ['bubbly']);
  await service.deleteItem(store, 'bubbly');
});

test('배포될 Lambda 묶음: API Gateway 이벤트로 화면·API·MCP 가 동작한다', async () => {
  Object.assign(process.env, {
    TABLE_NAME: TABLE, APP_KEY: 'app-key-xyz', MCP_KEY: 'mcp-key-xyz', PUBLIC_READ: 'true', BASE_PATH: '/english', AWS_REGION: 'ap-northeast-2',
    AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x', AWS_ENDPOINT_URL_DYNAMODB: endpoint,
  });
  const { handler } = await import('../dist/lambda/index.mjs');
  const ev = (method, path, { body, headers = {}, base64 = false } = {}) => ({
    version: '2.0', rawPath: path, rawQueryString: '', headers,
    requestContext: { http: { method, path } },
    body: body === undefined ? undefined : base64 ? Buffer.from(JSON.stringify(body)).toString('base64') : JSON.stringify(body), isBase64Encoded: base64,
  });
  const auth = { authorization: 'Bearer app-key-xyz', 'content-type': 'application/json' };

  const page = await handler(ev('GET', '/'));
  assert.equal(page.statusCode, 200); assert.match(page.body, /<title>Rewind 영어 복습<\/title>/);
  assert.equal((await handler(ev('GET', '/icon-512.png'))).isBase64Encoded, true);
  assert.equal(JSON.parse((await handler(ev('GET', '/api/me'))).body).role, 'guest', '열쇠 없이 열면 손님');
  // 서비스 경로: API Gateway 가 /english 를 붙여 보내도, 떼어 보내도 동작한다
  const bare = await handler(ev('GET', '/english'));
  assert.equal(bare.statusCode, 308); assert.equal(bare.headers.location, '/english/');
  const under = await handler(ev('GET', '/english/'));
  assert.equal(under.statusCode, 200); assert.match(under.body, /<base href="\/english\/">/);
  assert.equal(JSON.parse((await handler(ev('GET', '/english/api/me'))).body).role, 'guest');
  assert.equal((await handler(ev('GET', '/english/icon-192.png'))).statusCode, 200);
  // 로그인 쿠키: API Gateway 는 쿠키를 event.cookies 로 주고, 응답의 cookies 배열로 받는다
  const session = await handler(ev('POST', '/english/api/session', { headers: { authorization: 'Bearer app-key-xyz' } }));
  assert.equal(session.statusCode, 200); assert.match(session.cookies[0], /^rewind_key=app-key-xyz; Path=\/english\/;/);
  const viaCookie = await handler({ ...ev('GET', '/english/api/me'), cookies: ['a=b', 'rewind_key=app-key-xyz'] });
  assert.equal(JSON.parse(viaCookie.body).role, 'owner');
  assert.equal((await handler(ev('GET', '/api/state', { headers: { authorization: 'Bearer wrong' } }))).statusCode, 401);

  const rpc = async (msg) => handler(ev('POST', '/mcp/mcp-key-xyz', { body: msg, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }));
  const add = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_items', arguments: { picked_by: 'user', items: [{ text: 'on the house', meaning_ko: '가게에서 무료로 주는', examples: [{ en: 'Drinks are [on the house].' }] }] } } });
  assert.equal(add.statusCode, 200);
  assert.equal(JSON.parse(add.body).result.structuredContent.results[0].status, 'created');

  // 앱에서 보이고, 학습 상태를 바꿀 수 있다 (본문이 base64 로 와도 읽는다)
  let state = JSON.parse((await handler(ev('GET', '/api/state', { headers: auth }))).body);
  assert.deepEqual(state.items.map((i) => i.id), ['on-the-house']);
  const st = { h: 1, last: 5, intro: 5, seen: 1, right: 0, wrong: 0, recent: '', sq: 1 };
  assert.equal((await handler(ev('PATCH', '/api/items/on-the-house', { body: { st }, headers: auth, base64: true }))).statusCode, 200);
  state = JSON.parse((await handler(ev('GET', '/api/state', { headers: auth }))).body);
  assert.deepEqual(state.items[0].st, st);
  assert.equal((await handler(ev('DELETE', '/api/items/on-the-house', { headers: auth }))).statusCode, 204);
});

test('DynamoDB 접속 기록: IP별 횟수, 처음 키 사용 시각, 최근순', async () => {
  const name = 'rewind-traffic-test';
  await client.send(new CreateTableCommand({
    TableName: name, BillingMode: 'PROVISIONED', ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
  }));
  await waitUntilTableExists({ client, maxWaitTime: 10, minDelay: 0.05, maxDelay: 0.2 }, { TableName: name });
  const t = createDynamoTraffic({ tableName: name, client });
  await t.recordVisit({ ip: '1.1.1.1', kind: 'page', ua: 'Safari', now: 1000 });
  await t.recordVisit({ ip: '1.1.1.1', kind: 'app', ua: 'Safari', now: 2000 });
  await t.recordVisit({ ip: '1.1.1.1', kind: 'app', ua: 'Safari', now: 3000 });
  await t.recordVisit({ ip: '2.2.2.2', kind: 'other', ua: 'curl', path: '/.env', now: 4000 });
  const v = await t.listVisits();
  assert.deepEqual(v.map((x) => x.ip), ['2.2.2.2', '1.1.1.1']);
  assert.deepEqual(v[1], { ip: '1.1.1.1', firstSeen: 1000, lastSeen: 3000, ua: 'Safari', n_page: 1, n_app: 2, firstKey_app: 2000 });
  assert.equal(v[0].lastPath, '/.env'); assert.equal(v[0].n_other, 1);
});

test('DynamoDB 사람별 진도·초대 코드: 한 번만 쓰고, 진도는 섞이지 않는다', async () => {
  const store = createDynamoStore({ tableName: TABLE, client });
  const users = await import('../server/users.mjs');
  await service.addItems(store, { picked_by: 'user', items: [{ text: 'spill the beans', meaning_ko: '비밀을 털어놓다', examples: [{ en: 'Who [spilled the beans]?' }] }] }, 1000);
  const inv = await users.createInvite(store, OWNER, { name: '민수' }, 1000);
  const a = await users.redeemInvite(store, inv.code.toLowerCase().slice(0, 4) + '-' + inv.code.slice(4), 2000);
  assert.equal(a.user.name, '민수'); assert.equal(a.user.role, 'friend');
  assert.equal(await users.redeemInvite(store, inv.code, 2001), null, '두 번은 못 쓴다');
  const friend = await users.resolveApp(store, { appKey: 'k', mcpKey: 'm' }, 'Bearer ' + a.token);
  assert.equal(friend.uid, a.user.uid);
  const st = { h: 2, last: 9, intro: 9, seen: 1, right: 1, wrong: 0, recent: '1', sq: 0 };
  await service.patchItem(store, friend, 'spill-the-beans', { st, off: true });
  assert.deepEqual((await service.getState(store, friend)).items[0].st, st);
  assert.equal((await service.getState(store, OWNER)).items[0].st, null, '주인의 진도는 그대로');
  assert.equal((await service.getState(store, OWNER)).items[0].off, false);
  await service.putSession(store, friend, 's1794717000000', { startedAt: 1794717000000, ev: [] });
  assert.equal((await store.listSessions(10, friend.uid)).length, 1);
  assert.ok(!(await store.listSessions(100, 'owner')).some((x) => x.id === 's1794717000000'));
  await users.revokeUser(store, friend.uid, 3000);
  assert.equal(await users.resolveApp(store, { appKey: 'k', mcpKey: 'm' }, 'Bearer ' + a.token), null);
  await service.deleteItem(store, 'spill-the-beans');
});
