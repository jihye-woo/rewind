/**
 * 서비스 계층. 앱 API와 MCP 도구가 모두 이 함수들을 부른다.
 * 저장소(store)는 store-memory.mjs / store-dynamo.mjs 중 하나이고, 둘의 메서드는 같다.
 * 단어장은 표현 → 뜻 구조이고(catalog.mjs), 여기서 다루는 "항목"은 뜻 하나(unit)다.
 */
import { Core } from '../shared/core.js';
import * as cat from './catalog.mjs';

const ITEM_ID = cat.UNIT_ID;
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
 * 등록. MCP의 add_items와 앱의 붙여넣기 등록이 같은 경로를 탄다.
 * 표현은 원형·활용형으로 찾는다(applied → apply). 뜻은 이렇게 정한다:
 *   sense_id 를 주면 그 뜻에 합친다 → new_sense 면 새 뜻 → 뜻 풀이가 같은 뜻이 있으면 거기에 합친다 → 아니면 새 뜻.
 * 새 뜻을 만들 때는 경고로 알려 준다(같은 뜻을 다르게 적은 것이면 sense_id 로 다시 보내라고).
 * @returns {{results: Array, errors: string[], warnings: string[], items: object[]}}  items 는 저장된 뜻(unit)
 */
export async function addItems(store, payload, now = Date.now()) {
  const n = Core.normalizePayload(payload, now);
  const results = [], saved = [];
  const index = cat.formIndex(await cat.loadExprs(store));
  for (const inc of n.items) {
    if (!ITEM_ID.test(inc.id)) { n.errors.push(`${inc.text}: 항목 ID를 만들 수 없는 이름입니다.`); continue; }
    const exprId = index.get(Core.normText(inc.text)) || inc.forms.map((f) => index.get(f)).find(Boolean) || inc.id;
    let expr = await cat.getExpr(store, exprId), sense, status;
    if (!expr) {
      expr = { id: exprId, kind: inc.kind, text: inc.text, ipa: inc.ipa, forms: [], createdAt: inc.createdAt, senses: [] };
    } else {
      expr.ipa = expr.ipa || inc.ipa;
    }
    // 활용형: 다른 형태로 들어왔으면 그 형태도 활용형으로 적어 둔다
    const forms = new Set((expr.forms || []).map(Core.normText));
    for (const f of inc.forms.concat(Core.normText(inc.text) !== Core.normText(expr.text) ? [Core.normText(inc.text)] : [])) {
      if (f && f !== Core.normText(expr.text)) forms.add(f);
    }
    expr.forms = [...forms].slice(0, 12);
    const byId = inc.sense_id && expr.senses.find((x) => x.id === inc.sense_id);
    if (inc.sense_id && !byId) n.warnings.push(`${inc.text}: sense_id ${inc.sense_id} 가 없어 뜻 풀이로 찾았습니다.`);
    const target = byId || (!inc.new_sense && expr.senses.find((x) => cat.sameMeaning(x.meaning_ko, inc.meaning_ko)));
    if (target) {
      const old = cat.unitsOf(expr).find((u) => u.id === target.id);
      const merged = Core.mergeItem(old, inc);
      sense = cat.senseFrom({ ...merged, register: target.register || inc.register }, target.id);
      expr.senses = expr.senses.map((x) => (x.id === target.id ? sense : x));
      status = old.pending && !sense.pending ? 'accepted' : 'merged';
    } else {
      sense = cat.senseFrom({ ...inc, st: null }, cat.nextSenseId(expr));
      if (expr.senses.length) {
        status = 'new_sense';
        n.warnings.push(`${expr.text}: 뜻 풀이가 기존 뜻(${expr.senses.map((x) => x.id + ' ' + x.meaning_ko).join(', ')})과 달라 새 뜻 ${sense.id} 로 넣었습니다. 같은 뜻이면 sense_id 를 넣어 다시 보내세요.`);
      } else status = inc.pending ? 'candidate' : 'created';
      expr.senses.push(sense);
    }
    await cat.saveExpr(store, expr);
    index.set(Core.normText(expr.text), expr.id); expr.forms.forEach((f) => index.has(f) || index.set(f, expr.id));
    const unit = cat.unitsOf(expr).find((u) => u.id === sense.id);
    saved.push(unit);
    results.push({ id: unit.id, text: unit.text, sense: unit.senseNo, meaning_ko: unit.meaning_ko, status, state: stateOf(unit) });
  }
  return { results, errors: n.errors, warnings: n.warnings, items: saved };
}

/**
 * 공유 항목에 그 사람의 학습 상태를 얹는다.
 * 단어 내용과 후보(pending) 여부는 모두가 같이 쓰고, st(진도)와 off(켜짐/꺼짐)는 사람마다 따로다.
 * 행이 없으면: 주인은 예전처럼 항목 문서의 값을, 다른 사람은 처음 상태(st 없음, off 는 항목의 기본값)를 쓴다.
 */
export function viewItem(item, user, row) {
  const st = row && 'st' in row ? row.st : (user && user.uid === 'owner' ? item.st ?? null : null);
  const off = row && 'off' in row ? !!row.off : !!item.off;
  return { ...item, st, off, pending: !!item.pending };
}

export async function viewItems(store, user, items) {
  const rows = user && user.uid ? await store.listStates(user.uid) : {};
  return items.map((it) => viewItem(it, user, rows[it.id]));
}

/** 등록된 항목 검색. query가 비면 최근 등록 순으로 돌려준다. */
export async function findItems(store, query, limit = 20, user) {
  const q = Core.normText(query || '');
  const all = await viewItems(store, user, await cat.loadUnits(store));
  const hit = (it) => !q
    || Core.normText(it.text).includes(q)
    || String(it.meaning_ko || '').toLowerCase().includes(q)
    || (it.synonyms || []).some((s) => Core.normText(s.text).includes(q));
  return all.filter(hit)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map((it) => ({ id: it.id, text: it.text, kind: it.kind, sense: it.senseNo, senses: it.senseCount, meaning_ko: it.meaning_ko, register: it.register || '', forms: it.forms, state: stateOf(it), examples: (it.examples || []).length }));
}

/** 그 사람의 화면 상태. 손님(uid 없음)은 진도와 세션이 비어 있다. */
export async function getState(store, user) {
  const [items, sessions] = await Promise.all([
    cat.loadUnits(store).then((all) => viewItems(store, user, all)),
    user && user.uid ? store.listSessions(120, user.uid) : [],
  ]);
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

/**
 * 그 사람의 학습 상태·켜짐/꺼짐을 바꾼다. 등록 내용은 건드리지 않는다.
 * pending: false(후보를 학습에 넣기)는 공유 항목에 적용되어 모두에게 후보가 아니게 된다.
 */
export async function patchItem(store, user, id, patch) {
  if (!ITEM_ID.test(id)) throw new InputError('항목 ID가 올바르지 않습니다.');
  if (!patch || typeof patch !== 'object') throw new InputError('본문이 비어 있습니다.');
  const clean = {};
  if ('st' in patch) clean.st = cleanSt(patch.st);
  if ('off' in patch) clean.off = !!patch.off;
  if ('pending' in patch) clean.pending = !!patch.pending;
  if (!Object.keys(clean).length) throw new InputError('바꿀 값이 없습니다. st, off, pending 중 하나를 보내세요.');
  const expr = await cat.getExpr(store, cat.exprIdOf(id));
  let item = expr && cat.unitsOf(expr).find((u) => u.id === id);
  if (!item) return null;
  if ('pending' in clean && clean.pending !== !!item.pending) {
    // 후보를 받아들이면 그 뜻의 기본값도 켜짐으로 바꾼다. 아직 행이 없는 다른 사람에게도 켜진 채 보인다.
    expr.senses = expr.senses.map((x) => (x.id === id ? { ...x, ...(clean.pending ? { pending: true } : { pending: false, off: false }) } : x));
    await cat.saveExpr(store, expr);
    item = cat.unitsOf(expr).find((u) => u.id === id);
  }
  const mine = {};
  if ('st' in clean) mine.st = clean.st;
  if ('off' in clean) mine.off = clean.off;
  let row = await store.getStateRow(user.uid, id);
  if (Object.keys(mine).length) {
    await store.patchState(user.uid, id, mine);
    row = { ...(row || {}), ...mine };
  }
  return viewItem(item, user, row);
}

export async function deleteItem(store, id) {
  if (!ITEM_ID.test(id)) throw new InputError('항목 ID가 올바르지 않습니다.');
  await cat.deleteUnit(store, id);
}

/** 세션 로그 저장. 카드 결과는 덧붙이기만 하므로 문서 전체를 다시 쓴다. */
export async function putSession(store, user, id, doc) {
  if (!SESSION_ID.test(id)) throw new InputError('세션 ID가 올바르지 않습니다.');
  if (!doc || typeof doc !== 'object') throw new InputError('본문이 비어 있습니다.');
  const startedAt = num(doc.startedAt);
  if (startedAt === null) throw new InputError('startedAt이 없습니다.');
  const ev = (Array.isArray(doc.ev) ? doc.ev : []).slice(0, 300).map((e) => {
    const o = { i: String(e.i || '').slice(0, 90), t: String(e.t || '').slice(0, 20), at: num(e.at) };
    if (e.r === 0 || e.r === 1) o.r = e.r;
    if (e.v) o.v = String(e.v).slice(0, 10);
    if (e.x) o.x = 1;
    if (e.ex) o.ex = String(e.ex).slice(0, 12); // 보여 준 예문의 키 (Core.exKey)
    return o;
  });
  const clean = { startedAt, endedAt: num(doc.endedAt), n: ev.length, ev };
  await store.putSession(id, clean, user.uid);
  return clean;
}

/**
 * 백업(/api/export 의 결과)이나 프로토타입에서 내보낸 데이터를 되살린다.
 * 등록 내용은 add_items 와 같은 검사를 거치고, 처음 등록 시각·학습 상태·켜짐/꺼짐은 파일의 값을 그대로 쓴다.
 * 이미 있는 항목은 건너뛴다. overwrite 가 true 면 파일의 값으로 덮어쓴다.
 */
export async function importAll(store, data, { overwrite = false } = {}) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) throw new InputError('items 배열이 있는 백업 파일이 아닙니다.');
  const out = { items: { imported: 0, skipped: 0, rejected: [] }, sessions: { imported: 0, rejected: [] } };
  for (const raw of data.items.slice(0, 5000)) {
    const src = raw && (raw.src || raw.source);
    const n = Core.normalizePayload({ picked_by: 'user', items: [{ ...raw, sense_id: undefined, source: src || undefined }] }, num(raw && raw.createdAt) || Date.now());
    const inc = n.items[0];
    const unitId = raw && typeof raw.id === 'string' && ITEM_ID.test(raw.id) ? raw.id : inc && inc.id;
    if (!inc || !ITEM_ID.test(unitId)) { out.items.rejected.push(String((raw && raw.text) || '') + ': ' + (n.errors[0] || '읽을 수 없는 항목')); continue; }
    let st;
    try { st = raw.st == null ? null : cleanSt(raw.st); }
    catch (e) { out.items.rejected.push(inc.text + ': ' + e.message); continue; }
    const exprId = cat.exprIdOf(unitId);
    const expr = (await cat.getExpr(store, exprId)) || { id: exprId, kind: inc.kind, text: inc.text, ipa: inc.ipa, forms: [], createdAt: inc.createdAt, senses: [] };
    if (!overwrite && expr.senses.some((x) => x.id === unitId)) { out.items.skipped++; continue; }
    if (Array.isArray(raw.forms)) expr.forms = [...new Set((expr.forms || []).concat(raw.forms.map(Core.normText)))].slice(0, 12);
    const sense = cat.senseFrom({ ...inc, register: String(raw.register || ''), off: !!raw.off, pending: !!raw.pending }, unitId);
    delete sense.st;
    expr.senses = expr.senses.some((x) => x.id === unitId) ? expr.senses.map((x) => (x.id === unitId ? sense : x)) : expr.senses.concat([sense]);
    await cat.saveExpr(store, expr);
    await store.patchState('owner', unitId, { st, off: !!raw.off }); // 되살리기는 주인만 한다
    out.items.imported++;
  }
  for (const s of (Array.isArray(data.sessions) ? data.sessions : []).slice(0, 20000)) {
    const id = s && (s.id || (num(s.startedAt) !== null ? 's' + s.startedAt : ''));
    try { await putSession(store, { uid: 'owner' }, String(id), s); out.sessions.imported++; }
    catch (e) { out.sessions.rejected.push(String(id) + ': ' + e.message); }
  }
  return out;
}

/** 공유 항목(그 사람의 진도를 얹어서)과 그 사람의 세션 로그. */
export async function exportAll(store, user) {
  const [items, sessions] = await Promise.all([cat.loadUnits(store).then((all) => viewItems(store, user, all)), store.listSessions(100000, user.uid)]);
  return { exportedAt: new Date().toISOString(), items, sessions };
}
