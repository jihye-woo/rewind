/**
 * 단어장: 표현 → 뜻 (docs/GOAL.md 2절).
 *
 *   EXPR/<표현 ID>  { id, kind, text(원형), ipa, forms[](활용형), createdAt,
 *                    senses: [{ id, meaning_ko, register, note, examples, synonyms, antonyms,
 *                               wrong_meanings_ko, wrong_fills, priority, src, createdAt, pending, off }] }
 *
 * 학습 단위는 뜻이다. 뜻 ID 는 첫 뜻이 표현 ID 와 같고(예: apply), 둘째부터 apply~2, apply~3 …
 * 그래서 예전 항목 ID 가 그대로 첫 뜻의 ID 가 되고, 사람별 진도(ST#<uid>)와 세션 기록은 고치지 않는다.
 *
 * 예전 ITEM 행은 옮기기 전까지 "뜻 하나짜리 표현"으로 바꿔 읽는다(두 구조를 다 읽는다).
 * 어떤 표현이든 한 번 저장하면 EXPR 행이 되고, 같은 ID 의 ITEM 행은 가려진다(지우지는 않는다: 되돌리기용).
 *
 * 화면과 학습 규칙(shared/core.js)에는 뜻 하나를 예전 "항목"과 같은 모양(unit)으로 펼쳐 넘긴다:
 *   { ...뜻의 칸, id: 뜻 ID, exprId, kind, text, ipa, forms, senseNo, senseCount }
 */
import { Core } from '../shared/core.js';

export const SENSE_FIELDS = ['meaning_ko', 'register', 'note', 'examples', 'synonyms', 'antonyms', 'wrong_meanings_ko', 'wrong_fills', 'priority', 'src', 'createdAt', 'pending', 'off', 'st',
  'collocations', 'contrasts', 'trends', 'refinedAt'];
export const UNIT_ID = /^[a-z0-9][a-z0-9-]{0,89}(~[0-9]{1,3})?$/;

export const exprIdOf = (unitId) => String(unitId).split('~')[0];

export function senseFrom(u, id) {
  const s = { id };
  for (const k of SENSE_FIELDS) if (u[k] !== undefined) s[k] = u[k];
  if (s.register == null) s.register = '';
  return s;
}

/** 예전 ITEM 하나 → 뜻 하나짜리 표현. st(주인의 예전 진도)는 뜻에 그대로 둔다. 옮기기 스크립트가 사람별 진도로 옮긴다. */
export function legacyToExpr(item) {
  return { id: item.id, kind: item.kind, text: item.text, ipa: item.ipa || '', forms: [], createdAt: item.createdAt, senses: [senseFrom(item, item.id)], legacy: true };
}

export function unitsOf(expr) {
  const n = expr.senses.length;
  return expr.senses.map((s, i) => ({ ...s, id: s.id, exprId: expr.id, kind: expr.kind, text: expr.text, ipa: expr.ipa || '', forms: expr.forms || [], senseNo: i + 1, senseCount: n }));
}

/** 모든 표현. 옮긴 것(EXPR)과 아직 안 옮긴 것(ITEM → 표현)을 합친다. */
export async function loadExprs(store) {
  const [exprs, legacy] = await Promise.all([store.listDocs('EXPR'), store.listItems()]);
  const taken = new Set(exprs.map((e) => e.id));
  exprs.forEach((e) => e.senses.forEach((s) => taken.add(s.id)));
  return exprs.concat(legacy.filter((i) => !taken.has(i.id)).map(legacyToExpr));
}

export async function loadUnits(store) { return (await loadExprs(store)).flatMap(unitsOf); }

export async function getExpr(store, exprId) {
  const e = await store.getDoc('EXPR', exprId);
  if (e) return e;
  const it = await store.getItem(exprId);
  return it ? legacyToExpr(it) : null;
}

export async function getUnit(store, unitId) {
  const e = await getExpr(store, exprIdOf(unitId));
  return e ? unitsOf(e).find((u) => u.id === unitId) || null : null;
}

export async function saveExpr(store, expr) {
  const { legacy, ...doc } = expr;
  await store.putDoc('EXPR', doc.id, doc);
}

/** 뜻 하나를 지운다. 뜻이 없어지면 표현도 지운다. 같은 ID 의 예전 ITEM 행도 지운다(남겨 두면 다시 보이므로). */
export async function deleteUnit(store, unitId) {
  const expr = await getExpr(store, exprIdOf(unitId));
  if (expr) {
    expr.senses = expr.senses.filter((s) => s.id !== unitId);
    if (expr.senses.length) await saveExpr(store, expr);
    else if (!expr.legacy) await store.deleteDoc('EXPR', expr.id);
  }
  await store.deleteItem(unitId);
}

/** 같은 표현 안에서 다음 뜻 ID */
export function nextSenseId(expr) {
  if (!expr.senses.length) return expr.id;
  let n = 1;
  for (const s of expr.senses) { const m = s.id.match(/~(\d+)$/); n = Math.max(n, m ? +m[1] : 1); }
  return `${expr.id}~${n + 1}`;
}

/** 뜻이 같은지: 공백·문장부호를 빼고 비교한다 */
export const sameMeaning = (a, b) => {
  const k = (s) => String(s || '').toLowerCase().replace(/[\s.,·~…'"()\[\]-]/g, '');
  return !!k(a) && k(a) === k(b);
};

/** 원형·활용형 → 표현 ID 찾기표 */
export function formIndex(exprs) {
  const m = new Map();
  for (const e of exprs) {
    m.set(Core.normText(e.text), e.id);
    for (const f of e.forms || []) if (!m.has(Core.normText(f))) m.set(Core.normText(f), e.id);
  }
  return m;
}

/**
 * 강조어가 앞에 붙은 조합(so capable)의 핵심 표현(capable). 아니면 null.
 * 강조어를 떼고 남은 것이 한 단어이거나 이미 있는 표현일 때만 그렇게 본다(too good to be true 같은 관용구는 건드리지 않는다).
 * 관사는 강조어로 보지 않는다: a cross word 와 cross word(낱말 퍼즐)는 다른 말이다.
 */
export const INTENSIFIERS = new Set(['so', 'very', 'really', 'too', 'super', 'pretty', 'quite', 'extremely', 'highly', 'absolutely', 'totally', 'completely', 'incredibly', 'such']);
export function coreOf(text, known = new Set()) {
  const w = Core.normText(text).split(' ').filter(Boolean);
  let i = 0;
  while (i < w.length - 1 && INTENSIFIERS.has(w[i])) i++;
  if (!i) return null;
  const rest = w.slice(i).join(' ');
  return w.length - i === 1 || known.has(rest) ? rest : null;
}

