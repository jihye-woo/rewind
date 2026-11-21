/**
 * 로컬 실행용 서버. AWS 없이 메모리 저장소로 앱 전체를 띄운다.
 *   npm run dev   →  http://localhost:8787/#key=dev-app-key
 *   MCP 엔드포인트:  http://localhost:8787/mcp/dev-mcp-key
 *   키 없이 열면 읽기 전용으로 보인다 (배포 기본값과 같음)
 * 서버를 끄면 데이터는 사라진다.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { route } from './http.mjs';
import { createMemoryStore, createMemoryTraffic } from './store-memory.mjs';

export async function startLocal({ port = 8787, store = createMemoryStore(), traffic = createMemoryTraffic(), appKey = 'dev-app-key', mcpKey = 'dev-mcp-key', publicRead = true, now } = {}) {
  // 로컬은 서비스 경로 없이 루트에서 띄운다
  const { assets } = await import('../dist/web-assets.mjs');
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://localhost');
    const out = await route({
      method: req.method, path: url.pathname, headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
      ip: req.socket.remoteAddress,
    }, { store, traffic, config: { appKey, mcpKey, publicRead }, assets, now });
    res.writeHead(out.status, { ...out.headers, ...(out.cookies ? { 'set-cookie': out.cookies } : {}) });
    res.end(out.base64 ? Buffer.from(out.body, 'base64') : out.body);
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return { server, store, traffic, port: server.address().port, close: () => new Promise((ok) => server.close(ok)) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startLocal({ port: Number(process.env.PORT) || 8787 });
  console.log(`앱:  http://localhost:${port}/#key=dev-app-key`);
  console.log(`MCP: http://localhost:${port}/mcp/dev-mcp-key`);
}
