/**
 * HTTP 라우터. Lambda(handler.mjs)와 로컬 서버(local.mjs)가 같은 함수를 부른다.
 *
 *   GET  /                        앱 화면 (인증 없음. 화면 자체에는 데이터가 없다)
 *   GET  /api/state               항목 + 최근 세션          ┐ (publicRead 이면 키 없이도 읽기 전용으로 허용)
 *   POST /api/add-items           항목 등록                 │ Authorization: Bearer <앱 키>
 *   PATCH/DELETE /api/items/{id}  학습 상태 변경, 삭제      │
 *   PUT  /api/sessions/{id}       세션 로그 저장            │
 *   GET  /api/export              전체 백업                 │
 *   POST /api/import              백업 되살리기             ┘
 *   POST /mcp/{MCP 키}            MCP 엔드포인트 (ChatGPT가 호출)
 */
import { timingSafeEqual } from 'node:crypto';
import { handleMcp, SUPPORTED_VERSIONS } from './mcp.mjs';
import * as service from './service.mjs';

const MAX_BODY = 256 * 1024;

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const json = (status, body, extra = {}) => ({
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY, ...extra },
  body: JSON.stringify(body),
});
const empty = (status, extra = {}) => ({ status, headers: { 'cache-control': 'no-store', ...SECURITY, ...extra }, body: '' });

/** 길이가 달라도 걸리는 시간이 같도록 비교한다. */
function sameSecret(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

function parseBody(req) {
  if (!req.body) return undefined;
  if (Buffer.byteLength(req.body) > MAX_BODY) throw new service.InputError('본문이 너무 큽니다.');
  try { return JSON.parse(req.body); } catch { throw new service.InputError('본문이 JSON이 아닙니다.'); }
}

/**
 * @param {{method: string, path: string, headers: Record<string,string>, body?: string}} req  headers의 키는 소문자
 * @param {{store: object, config: {appKey: string, mcpKey: string, publicRead?: boolean}, assets: object, now?: () => number}} deps
 */
export async function route(req, deps) {
  const { store, config, assets } = deps;
  const method = req.method.toUpperCase();
  const path = req.path.replace(/\/+$/, '') || '/';

  try {
    // ---- 앱 화면과 아이콘 ----
    if (STATIC[path]) {
      if (method !== 'GET' && method !== 'HEAD') return empty(405, { allow: 'GET' });
      const [name, type] = STATIC[path];
      const asset = assets[name];
      if (!asset) return empty(404);
      const isHtml = name === 'index.html';
      return {
        status: 200,
        headers: { 'content-type': type, 'cache-control': isHtml ? 'no-cache' : 'public, max-age=86400', ...SECURITY, ...(isHtml ? { 'content-security-policy': CSP } : {}) },
        body: asset.body, base64: !!asset.base64,
      };
    }

    // ---- MCP ----
    if (path.startsWith('/mcp/')) {
      // 키가 틀리면 엔드포인트가 없는 것처럼 답한다
      if (!sameSecret(decodeURIComponent(path.slice(5)), config.mcpKey)) return empty(404);
      if (method !== 'POST') return empty(405, { allow: 'POST' }); // SSE 스트림(GET)과 세션 종료(DELETE)는 제공하지 않는다
      const version = req.headers['mcp-protocol-version'];
      if (version && !SUPPORTED_VERSIONS.includes(version)) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${version}` } });
      let message;
      try { message = parseBody(req); } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const r = await handleMcp(message, { store, now: deps.now ? deps.now() : Date.now() });
      return r.json ? json(r.status, r.json) : empty(r.status);
    }

    // ---- 앱 API ----
    if (path.startsWith('/api/')) {
      const auth = req.headers.authorization || '';
      // 키 없이 온 상태 조회는 publicRead 일 때 읽기 전용으로 답한다. 키를 보냈는데 틀리면 401 이다.
      if (!auth && config.publicRead && path === '/api/state' && method === 'GET') {
        return json(200, { ...(await service.getState(store)), readOnly: true });
      }
      if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7).trim(), config.appKey)) return json(401, { error: '접속 키가 없거나 올바르지 않습니다.' });

      if (path === '/api/state' && method === 'GET') return json(200, { ...(await service.getState(store)), readOnly: false });
      if (path === '/api/export' && method === 'GET') return json(200, await service.exportAll(store));
      if (path === '/api/import' && method === 'POST') {
        const body = parseBody(req) || {};
        return json(200, await service.importAll(store, body.data || body, { overwrite: body.overwrite === true }));
      }
      if (path === '/api/add-items' && method === 'POST') {
        return json(200, await service.addItems(store, parseBody(req) || {}, deps.now ? deps.now() : Date.now()));
      }
      let m = path.match(/^\/api\/items\/([^/]+)$/);
      if (m && method === 'PATCH') {
        const item = await service.patchItem(store, decodeURIComponent(m[1]), parseBody(req));
        return item ? json(200, { item }) : json(404, { error: '없는 항목입니다.' });
      }
      if (m && method === 'DELETE') { await service.deleteItem(store, decodeURIComponent(m[1])); return empty(204); }
      m = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (m && method === 'PUT') return json(200, { session: await service.putSession(store, decodeURIComponent(m[1]), parseBody(req)) });
      return json(404, { error: '없는 경로입니다.' });
    }

    return empty(404);
  } catch (e) {
    if (e instanceof service.InputError) return json(400, { error: e.message });
    console.error('request failed', method, path, e);
    return json(500, { error: '서버에서 처리하지 못했습니다.' });
  }
}
