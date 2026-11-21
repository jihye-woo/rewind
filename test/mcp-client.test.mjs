/** 공식 MCP 클라이언트(SDK)로 실제 HTTP 서버에 접속해, ChatGPT 같은 클라이언트가 하는 순서대로 호출한다. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startLocal } from '../server/local.mjs';
import * as cat from '../server/catalog.mjs';

test('공식 클라이언트: 접속 → 도구 목록 → 등록 → 검색', async () => {
  const local = await startLocal({ port: 0 });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${local.port}/mcp/dev-mcp-key`)));
    assert.equal(client.getServerVersion().name, 'rewind');
    assert.match(client.getInstructions(), /picked_by/);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['add_items', 'find_items']);
    assert.equal(tools[1].annotations.readOnlyHint, true);
    assert.equal(tools[0].annotations.readOnlyHint, false);
    assert.deepEqual(tools[0].inputSchema.required, ['items']);

    // 사용자가 고른 표현 하나 + GPT가 고른 표현 하나
    const added = await client.callTool({ name: 'add_items', arguments: {
      source: { text: 'Kayla kept her head down, worked hard. Never had a cross word for anyone.', ko: '케일라는 묵묵히 일했다.' },
      items: [
        { text: "keep one's head down", meaning_ko: '나서지 않고 조용히 지내다', picked_by: 'user', examples: [{ en: 'Kayla kept her [head down].' }, { en: 'Keep your [head down].' }, { en: 'He kept his [head down].' }] },
        { text: 'a cross word', meaning_ko: '화난 말', examples: [{ en: 'Never had [a cross word].' }] },
      ],
    } });
    assert.ok(!added.isError);
    assert.deepEqual(added.structuredContent.results.map((r) => [r.id, r.status]), [['keep-one-s-head-down', 'created'], ['a-cross-word', 'candidate']]);
    assert.match(added.content[0].text, /후보로 저장/);

    const found = await client.callTool({ name: 'find_items', arguments: { query: 'head down' } });
    assert.deepEqual(found.structuredContent.items.map((i) => [i.id, i.state]), [['keep-one-s-head-down', 'queued']]);

    const bad = await client.callTool({ name: 'add_items', arguments: { items: [] } });
    assert.equal(bad.isError, true);

    // 앱에서는 사용자가 고른 것만 학습 대기로 보인다
    const items = (await cat.loadUnits(local.store)).sort((a, b) => b.id.localeCompare(a.id));
    assert.deepEqual(items.map((i) => [i.id, i.pending, i.off, i.src.text.slice(0, 5)]), [['keep-one-s-head-down', false, false, 'Kayla'], ['a-cross-word', true, true, 'Kayla']]);
  } finally {
    await client.close().catch(() => {});
    await local.close();
  }
});

test('공식 클라이언트: 키가 틀리면 접속되지 않는다', async () => {
  const local = await startLocal({ port: 0 });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await assert.rejects(client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${local.port}/mcp/wrong-key`))));
  } finally { await local.close(); }
});
