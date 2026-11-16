/**
 * 사람과 열쇠. 단어장은 하나를 같이 쓰고, 학습 진도만 사람마다 따로 둔다.
 *
 *   주인(owner)   배포할 때 만든 앱 키(APP_KEY), 또는 주인이 자기 기기용으로 만든 초대 코드로 받은 열쇠
 *   친구(friend)  주인이 만든 초대 코드로 받은 열쇠. 주인과 똑같이 쓴다(등록·삭제 포함). 사람 관리와 접속 기록만 못 본다
 *   손님(guest)   열쇠 없이 연 사람. 모든 것을 읽기만 한다
 *
 * 열쇠·초대 코드·MCP 키는 SHA-256 으로 바꿔 저장한다. 저장소가 새도 원래 값은 알 수 없다.
 *   USER/<uid>        { uid, name, createdAt, revokedAt?, mcpHash? }
 *   TOKEN/<hash>      { uid, createdAt }          기기 하나에 열쇠 하나
 *   INVITE/<hash>     { name, target, createdBy, createdAt, expiresAt, usedAt?, uid? }
 *   MCPKEY/<hash>     { uid }                      사람마다 ChatGPT 연결 주소 하나
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { InputError } from './service.mjs';

export const OWNER = Object.freeze({ uid: 'owner', role: 'owner', name: '주인' });
export const GUEST = Object.freeze({ uid: null, role: 'guest', name: '' });

const INVITE_TTL = 24 * 3600 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 0 O 1 I L 은 뺐다
const CODE_LEN = 8;

export const hashSecret = (s) => createHash('sha256').update(String(s)).digest('base64url');

/** 길이가 달라도 걸리는 시간이 같도록 비교한다. */
export function sameSecret(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const normCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function userOf(store, uid) {
  if (uid === 'owner') return OWNER;
  const u = await store.getDoc('USER', uid);
  if (!u || u.revokedAt) return null;
  return { uid, role: 'friend', name: u.name };
}

/**
 * Authorization 헤더로 사람을 찾는다.
 * @returns 사람, 헤더가 없으면 GUEST, 열쇠가 틀렸거나 끊긴 사람이면 null
 */
export async function resolveApp(store, config, authorization) {
  const auth = String(authorization || '');
  if (!auth) return GUEST;
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return GUEST;
  if (sameSecret(token, config.appKey)) return OWNER;
  if (sameSecret(token, config.mcpKey)) return null; // MCP 키로는 앱 API를 쓸 수 없다
  const t = await store.getDoc('TOKEN', hashSecret(token));
  return t ? userOf(store, t.uid) : null;
}

/** MCP 주소의 키로 사람을 찾는다. 없으면 null. */
export async function resolveMcp(store, config, key) {
  if (sameSecret(key, config.mcpKey)) return OWNER;
  if (!key) return null;
  const m = await store.getDoc('MCPKEY', hashSecret(key));
  return m ? userOf(store, m.uid) : null;
}

function newCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/**
 * 초대 코드를 만든다.
 *   self: true  → 만든 사람의 새 기기용 (주인·친구 모두 가능. 같은 진도를 이어 쓴다)
 *   name: '...' → 새 친구용 (주인만)
 */
export async function createInvite(store, user, body, now) {
  const self = !!(body && body.self);
  const name = String((body && body.name) || '').trim().slice(0, 30);
  if (!self && !name) throw new InputError('초대할 사람의 이름을 넣으세요.');
  const code = newCode();
  const doc = {
    name: self ? user.name : name, target: self ? user.uid : 'new', createdBy: user.uid,
    createdAt: now, expiresAt: now + INVITE_TTL,
  };
  await store.putDoc('INVITE', hashSecret(code), doc);
  return { code, name: doc.name, self, expiresAt: doc.expiresAt };
}

/** 초대 코드를 열쇠로 바꾼다. 코드는 한 번만 쓸 수 있다. 실패하면 null. */
export async function redeemInvite(store, code, now) {
  const c = normCode(code);
  if (c.length !== CODE_LEN) return null;
  const sk = hashSecret(c);
  const pending = await store.getDoc('INVITE', sk);
  if (!pending) return null;
  const uid = pending.target === 'new' ? 'u' + randomBytes(6).toString('hex') : pending.target;
  if (uid !== 'owner' && pending.target !== 'new' && !(await userOf(store, uid))) return null; // 그 사이 끊긴 사람
  const claimed = await store.claimInvite(sk, now, uid);
  if (!claimed) return null;
  if (pending.target === 'new') await store.putDoc('USER', uid, { uid, name: claimed.name, createdAt: now });
  const token = randomBytes(24).toString('base64url');
  await store.putDoc('TOKEN', hashSecret(token), { uid, createdAt: now });
  return { token, user: await userOf(store, uid) };
}

/** 주인이 보는 사람 목록과 최근 30일의 초대. */
export async function listPeople(store, now) {
  const [users, invites] = await Promise.all([store.listDocs('USER'), store.listDocs('INVITE')]);
  return {
    users: users.filter((u) => u.uid !== 'owner').map(({ mcpHash, ...u }) => ({ ...u, mcp: !!mcpHash }))
      .sort((a, b) => a.createdAt - b.createdAt),
    invites: invites.filter((i) => i.createdAt > now - 30 * 86400000)
      .map(({ name, target, createdAt, expiresAt, usedAt }) => ({ name, self: target !== 'new', createdAt, expiresAt, usedAt: usedAt || null }))
      .sort((a, b) => b.createdAt - a.createdAt),
  };
}

/** 친구의 접속을 끊는다. 그 사람의 모든 기기 열쇠와 MCP 주소가 그 즉시 막힌다. 학습 기록은 남는다. */
export async function revokeUser(store, uid, now) {
  const u = uid && uid !== 'owner' ? await store.getDoc('USER', uid) : null;
  if (!u) return false;
  await store.putDoc('USER', uid, { ...u, revokedAt: u.revokedAt || now });
  return true;
}

/** 그 사람의 ChatGPT 연결용 MCP 키를 새로 만든다. 예전 키는 바로 못 쓰게 된다. 키는 이때 한 번만 보여 준다. */
export async function newMcpKey(store, user, now) {
  const doc = (await store.getDoc('USER', user.uid)) || { uid: user.uid, name: user.name, createdAt: now };
  if (doc.mcpHash) await store.deleteDoc('MCPKEY', doc.mcpHash);
  const key = randomBytes(24).toString('base64url');
  const h = hashSecret(key);
  await store.putDoc('MCPKEY', h, { uid: user.uid });
  await store.putDoc('USER', user.uid, { ...doc, mcpHash: h });
  return key;
}
