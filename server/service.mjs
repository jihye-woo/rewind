/**
 * 서비스 계층. 앱 API와 MCP 도구가 모두 이 함수들을 부른다.
 * 저장소(store)는 store-memory.mjs / store-dynamo.mjs 중 하나이고, 둘의 메서드는 같다.
 */
import { Core } from '../shared/core.js';

const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,89}$/;
const SESSION_ID = /^s\d{10,16}$/;

export class InputError extends Error {
  constructor(message) { super(message); this.name = 'InputError'; }
}

/** 항목의 현재 상태를 사람이 읽는 한 단어로. find_items 응답과 등록 결과에 쓴다. */
function stateOf(item) {
  if (item.pending) return 'candidate';
  if (item.off) return 'off';
  return Core.stage(item); // queued | learning | familiar
}

/**
 * 항목 등록. MCP의 add_items와 앱의 붙여넣기 등록이 같은 경로를 탄다.
 * @returns {{results: Array, errors: string[], warnings: string[], items: object[]}}
 */
export async function addItems(store, payload, now = Date.now()) {
  const n = Core.normalizePayload(payload, now);
  const results = [];
  const saved = [];
  for (const incoming of n.items) {
    if (!ITEM_ID.test(incoming.id)) { n.errors.push(`${incoming.text}: 항목 ID를 만들 수 없는 이름입니다.`); continue; }
    const existing = await store.getItem(incoming.id);
    let item, status;
    if (existing) {
      item = Core.mergeItem(existing, incoming);
      status = existing.pending && !item.pending ? 'accepted' : 'merged';
    } else {
      item = incoming;
      status = incoming.pending ? 'candidate' : 'created';
    }
    await store.putItem(item);
    saved.push(item);
    results.push({ id: item.id, text: item.text, status, state: stateOf(item) });
  }
  return { results, errors: n.errors, warnings: n.warnings, items: saved };
}

/** 등록된 항목 검색. query가 비면 최근 등록 순으로 돌려준다. */
export async function findItems(store, query, limit = 20) {
  const q = Core.normText(query || '');
  const all = await store.listItems();
  const hit = (it) => !q
    || Core.normText(it.text).includes(q)
    || String(it.meaning_ko || '').toLowerCase().includes(q)
    || (it.synonyms || []).some((s) => Core.normText(s.text).includes(q));
  return all.filter(hit)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map((it) => ({ id: it.id, text: it.text, kind: it.kind, meaning_ko: it.meaning_ko, state: stateOf(it), examples: (it.examples || []).length }));
}

export async function getState(store) {
  const [items, sessions] = await Promise.all([store.listItems(), store.listSessions(120)]);
  return { items, sessions, serverTime: Date.now() };
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

/** 화면이 보내는 학습 상태. 숫자와 길이를 확인한 뒤 저장한다. */
function cleanSt(st) {
  if (st === null) return null;
  if (typeof st !== 'object' || Array.isArray(st)) throw new InputError('st는 객체여야 합니다.');
  const h = num(st.h);
  if (h === null || h <= 0 || h > 400) throw new InputError('st.h 값이 올바르지 않습니다.');
  return {
    h, last: num(st.last), intro: num(st.intro),
    seen: Math.max(0, Math.floor(num(st.seen) || 0)), right: Math.max(0, Math.floor(num(st.right) || 0)),
    wrong: Math.max(0, Math.floor(num(st.wrong) || 0)), sq: Math.max(0, Math.floor(num(st.sq) || 0)),
    recent: String(st.recent || '').replace(/[^01]/g, '').slice(-5),
  };
}

/** 항목의 학습 상태·켜짐/꺼짐만 바꾼다. 등록 내용은 건드리지 않는다. */
export async function patchItem(store, id, patch) {
  if (!ITEM_ID.test(id)) throw new InputError('항목 ID가 올바르지 않습니다.');
  if (!patch || typeof patch !== 'object') throw new InputError('본문이 비어 있습니다.');
  const clean = {};
  if ('st' in patch) clean.st = cleanSt(patch.st);
  if ('off' in patch) clean.off = !!patch.off;
  if ('pending' in patch) clean.pending = !!patch.pending;
  if (!Object.keys(clean).length) throw new InputError('바꿀 값이 없습니다. st, off, pending 중 하나를 보내세요.');
  return store.patchItem(id, clean); // 없는 항목이면 null
}

export async function deleteItem(store, id) {
  if (!ITEM_ID.test(id)) throw new InputError('항목 ID가 올바르지 않습니다.');
  await store.deleteItem(id);
}

/** 세션 로그 저장. 카드 결과는 덧붙이기만 하므로 문서 전체를 다시 쓴다. */
export async function putSession(store, id, doc) {
  if (!SESSION_ID.test(id)) throw new InputError('세션 ID가 올바르지 않습니다.');
  if (!doc || typeof doc !== 'object') throw new InputError('본문이 비어 있습니다.');
  const startedAt = num(doc.startedAt);
  if (startedAt === null) throw new InputError('startedAt이 없습니다.');
  const ev = (Array.isArray(doc.ev) ? doc.ev : []).slice(0, 300).map((e) => {
    const o = { i: String(e.i || '').slice(0, 90), t: String(e.t || '').slice(0, 20), at: num(e.at) };
    if (e.r === 0 || e.r === 1) o.r = e.r;
    if (e.v) o.v = String(e.v).slice(0, 10);
    if (e.x) o.x = 1;
    return o;
  });
  const clean = { startedAt, endedAt: num(doc.endedAt), n: ev.length, ev };
  await store.putSession(id, clean);
  return clean;
}

export async function exportAll(store) {
  const [items, sessions] = await Promise.all([store.listItems(), store.listSessions(100000)]);
  return { exportedAt: new Date().toISOString(), items, sessions };
}
