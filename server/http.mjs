/**
 * HTTP 라우터. Lambda(handler.mjs)와 로컬 서버(local.mjs)가 같은 함수를 부른다.
 * 경로는 서비스 경로(/english)를 뗀 뒤의 것이다.
 *
 *   GET  /                        앱 화면 (인증 없음. 화면 자체에는 데이터가 없다)
 *
 *   Authorization: Bearer <앱 키 또는 기기 열쇠>. 틀린 열쇠는 401.
 *   헤더가 없으면 손님이다. publicRead 이면 주인의 화면(항목·진도·세션)을 읽기 전용으로 보여 주고, 아니면 401.
 *   손님의 그 밖의 요청(쓰기·백업·관리)은 모두 401.
 *   GET  /api/me                  나는 누구인가 (role: owner | friend | guest)      누구나
 *   GET  /api/state               항목(내 진도를 얹어서) + 내 최근 세션, readOnly  누구나 (손님은 주인의 것)
 *   POST /api/invites/redeem      초대 코드 → 기기 열쇠                              누구나
 *   POST /api/add-items           항목 등록                                          초대받은 사람
 *   PATCH/DELETE /api/items/{id}  내 학습 상태 변경, 항목 삭제(모두에게서)           초대받은 사람
 *   PUT  /api/sessions/{id}       내 세션 로그 저장                                  초대받은 사람
 *   GET  /api/export              백업 (공유 항목 + 내 진도·세션)                    초대받은 사람
 *   POST /api/invites             초대 코드 만들기 (내 새 기기용 / 새 친구용은 주인만) 초대받은 사람
 *   POST /api/me/mcp              내 ChatGPT 연결 주소 새로 만들기                   초대받은 사람
 *   GET  /api/people              사람과 초대 목록                                   주인
 *   DELETE /api/users/{uid}       친구 접속 끊기                                     주인
 *   GET  /api/traffic             IP별 접속 기록                                     주인
 *   POST /api/import              백업 되살리기                                      주인
 *
 *   POST /mcp/{MCP 키}            MCP 엔드포인트 (ChatGPT가 호출). 키에 따라 누구의 진도로 볼지 정해진다
 */
import { handleMcp, SUPPORTED_VERSIONS } from './mcp.mjs';
import * as service from './service.mjs';
import * as users from './users.mjs';

const MAX_BODY = 256 * 1024;
const MAX_UA = 200;

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

const json = (status, body, extra = {}) => ({
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY, ...extra },
  body: JSON.stringify(body),
});
const empty = (status, extra = {}) => ({ status, headers: { 'cache-control': 'no-store', ...SECURITY, ...extra }, body: '' });

const READ_ONLY = { error: '보기 전용입니다. 초대 코드를 받아 입력하면 쓸 수 있습니다.' };
const OWNER_ONLY = { error: '주인만 할 수 있습니다.' };

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

/** 요청한 사람을 찾는다. user 가 null 이면 열쇠가 틀린 것이다. */
async function authenticate(req, deps, path) {
  const { store, config } = deps;
  if (path.startsWith('/mcp/')) return { user: await users.resolveMcp(store, config, decodeURIComponent(path.slice(5))) };
  if (path.startsWith('/api/')) return { user: await users.resolveApp(store, config, req.headers.authorization) };
  return { user: users.GUEST };
}

/**
 * 접속 기록에 남길 종류. 아이콘처럼 화면이 따라 부르는 파일은 남기지 않는다(쓰기 용량을 아끼려고).
 *   page: 앱 화면   app: 열쇠로 부른 API   guest: 열쇠 없이 부른 API(읽기)   mcp: 맞는 MCP 키   denied: 틀린 열쇠   other: 없는 경로
 */
function classify(path, user) {
  if (path === '/' || path === '/index.html') return 'page';
  if (STATIC[path]) return null;
  if (path.startsWith('/mcp/')) return user ? 'mcp' : 'denied';
  if (path.startsWith('/api/')) return !user ? 'denied' : user.role === 'guest' ? 'guest' : 'app';
  return 'other';
}

/**
 * @param {{method: string, path: string, headers: Record<string,string>, body?: string, ip?: string}} req  headers의 키는 소문자
 * @param {{store: object, traffic?: object, config: {appKey: string, mcpKey: string, publicRead?: boolean, basePath?: string}, assets: object, now?: () => number}} deps
 *   traffic 을 주면 요청마다 IP별 접속 기록을 남긴다. 기록이 실패해도 응답에는 영향이 없다.
 */
export async function route(req, deps) {
  const method = req.method.toUpperCase();
  const path = req.path.replace(/\/+$/, '') || '/';
  let auth;
  try { auth = await authenticate(req, deps, path); }
  catch (e) { console.error('auth failed', method, path, e); return json(500, { error: '서버에서 처리하지 못했습니다.' }); }

  const kind = deps.traffic && req.ip ? classify(path, auth.user) : null;
  const recording = kind && deps.traffic.recordVisit({
    ip: req.ip, kind, now: deps.now ? deps.now() : Date.now(),
    ua: String(req.headers['user-agent'] || '').slice(0, MAX_UA),
    who: auth.user && auth.user.uid ? auth.user.name : undefined,
    path: kind === 'other' ? path.slice(0, 100) : undefined, // MCP 경로에는 키가 들어 있으므로 남기지 않는다
  }).catch((e) => console.warn('traffic record failed', e.name || e));
  const [res] = await Promise.all([handle(req, deps, method, path, auth.user), recording]);
  return res;
}

async function handle(req, deps, method, path, user) {
  const { store, config, assets } = deps;
  const now = deps.now ? deps.now() : Date.now();
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
        // 화면 안의 상대 경로(api/…, icon.svg)가 서비스 경로 아래를 가리키게 한다
        body: isHtml ? asset.body.replace('%%BASE%%', () => (config.basePath || '') + '/') : asset.body, base64: !!asset.base64,
      };
    }

    // ---- MCP ----
    if (path.startsWith('/mcp/')) {
      if (!user) return empty(404); // 키가 틀리면 엔드포인트가 없는 것처럼 답한다
      if (method !== 'POST') return empty(405, { allow: 'POST' }); // SSE 스트림(GET)과 세션 종료(DELETE)는 제공하지 않는다
      const version = req.headers['mcp-protocol-version'];
      if (version && !SUPPORTED_VERSIONS.includes(version)) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${version}` } });
      let message;
      try { message = parseBody(req); } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const r = await handleMcp(message, { store, now, user });
      return r.json ? json(r.status, r.json) : empty(r.status);
    }

    // ---- 앱 API ----
    if (path.startsWith('/api/')) {
      // 초대 코드는 열쇠가 없는(또는 끊긴) 기기에서 쓰므로 열쇠 검사보다 먼저 받는다
      if (path === '/api/invites/redeem' && method === 'POST') {
        const r = await users.redeemInvite(store, (parseBody(req) || {}).code, now);
        return r ? json(200, { token: r.token, me: r.user }) : json(400, { error: '초대 코드가 맞지 않거나, 이미 썼거나, 기한(24시간)이 지났습니다.' });
      }
      if (!user || (user.role === 'guest' && !config.publicRead)) return json(401, { error: '접속 키가 없거나 올바르지 않습니다.' });

      // 누구나. 손님은 주인의 화면을 읽기만 한다
      if (path === '/api/me' && method === 'GET') return json(200, { role: user.role, name: user.name, uid: user.uid });
      if (path === '/api/state' && method === 'GET') {
        const guest = user.role === 'guest';
        return json(200, { ...(await service.getState(store, guest ? users.OWNER : user)), readOnly: guest });
      }
      if (user.role === 'guest') return json(401, READ_ONLY); // 손님은 읽기만. 쓰기·백업은 열쇠가 있어야 한다

      // 초대받은 사람
      if (path === '/api/export' && method === 'GET') return json(200, await service.exportAll(store, user));
      if (path === '/api/add-items' && method === 'POST') {
        const r = await service.addItems(store, parseBody(req) || {}, now);
        return json(200, { ...r, items: await service.viewItems(store, user, r.items) });
      }
      let m = path.match(/^\/api\/items\/([^/]+)$/);
      if (m && method === 'PATCH') {
        const item = await service.patchItem(store, user, decodeURIComponent(m[1]), parseBody(req));
        return item ? json(200, { item }) : json(404, { error: '없는 항목입니다.' });
      }
      if (m && method === 'DELETE') { await service.deleteItem(store, decodeURIComponent(m[1])); return empty(204); }
      m = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (m && method === 'PUT') return json(200, { session: await service.putSession(store, user, decodeURIComponent(m[1]), parseBody(req)) });
      if (path === '/api/invites' && method === 'POST') {
        const body = parseBody(req) || {};
        if (!body.self && user.role !== 'owner') return json(403, { error: '새 친구 초대는 주인만 할 수 있습니다. 내 새 기기용 코드는 만들 수 있습니다.' });
        return json(200, await users.createInvite(store, user, body, now));
      }
      if (path === '/api/me/mcp' && method === 'POST') return json(200, { path: 'mcp/' + await users.newMcpKey(store, user, now) });

      // 주인
      const ownerOnly = path === '/api/people' || path === '/api/traffic' || path === '/api/import' || path.startsWith('/api/users/');
      if (ownerOnly && user.role !== 'owner') return json(403, OWNER_ONLY);
      if (path === '/api/people' && method === 'GET') return json(200, await users.listPeople(store, now));
      m = path.match(/^\/api\/users\/([^/]+)$/);
      if (m && method === 'DELETE') return (await users.revokeUser(store, decodeURIComponent(m[1]), now)) ? empty(204) : json(404, { error: '없는 사람입니다.' });
      if (path === '/api/traffic' && method === 'GET') {
        return json(200, { you: req.ip || null, enabled: !!deps.traffic, visits: deps.traffic ? await deps.traffic.listVisits() : [] });
      }
      if (path === '/api/import' && method === 'POST') {
        const body = parseBody(req) || {};
        return json(200, await service.importAll(store, body.data || body, { overwrite: body.overwrite === true }));
      }
      return json(404, { error: '없는 경로입니다.' });
    }

    return empty(404);
  } catch (e) {
    if (e instanceof service.InputError) return json(400, { error: e.message });
    console.error('request failed', method, path, e);
    return json(500, { error: '서버에서 처리하지 못했습니다.' });
  }
}
