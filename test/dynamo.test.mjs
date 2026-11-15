/**
 * DynamoDB 저장소와, 배포될 Lambda 묶음(dist/lambda/index.mjs)을 로컬 DynamoDB 흉내(dynalite)에 붙여 시험한다.
 * 실제 AWS 에는 접속하지 않는다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dynalite from 'dynalite';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { createDynamoStore } from '../server/store-dynamo.mjs';
import * as service from '../server/service.mjs';

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
  const patched = await service.patchItem(store, 'bubbly', { st });
  assert.deepEqual(patched.st, st); assert.equal(patched.text, 'bubbly'); assert.equal(patched.examples.length, 1);
  assert.equal(await service.patchItem(store, 'nothing', { off: true }), null);
  await service.patchItem(store, 'gorgeous', { off: true, pending: false });
  assert.equal((await store.getItem('gorgeous')).off, true);

  // 학습 상태를 바꾼 뒤 같은 항목을 다시 등록해도 상태가 남는다
  await service.addItems(store, { picked_by: 'user', items: [{ text: 'bubbly', meaning_ko: 'x', examples: [{ en: 'Some [bubbly]?' }] }] }, 2000);
  const merged = await store.getItem('bubbly');
  assert.deepEqual(merged.st, st); assert.equal(merged.examples.length, 2);

  for (const t of [1794717536455, 1794717600000, 1794717700000]) await service.putSession(store, 's' + t, { startedAt: t, ev: [{ i: 'bubbly', t: 'intro', at: t }] });
  assert.deepEqual((await store.listSessions(2)).map((s) => s.startedAt), [1794717700000, 1794717600000]);

  await service.deleteItem(store, 'gorgeous');
  assert.deepEqual((await store.listItems()).map((i) => i.id), ['bubbly']);
  await service.deleteItem(store, 'bubbly');
});

test('배포될 Lambda 묶음: API Gateway 이벤트로 화면·API·MCP 가 동작한다', async () => {
  Object.assign(process.env, {
    TABLE_NAME: TABLE, APP_KEY: 'app-key-xyz', MCP_KEY: 'mcp-key-xyz', AWS_REGION: 'ap-northeast-2',
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
  assert.equal((await handler(ev('GET', '/api/state'))).statusCode, 401);

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
