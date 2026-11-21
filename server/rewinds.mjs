/**
 * rewinds: 단어장을 목표 모습(docs/GOAL.md)으로 조금씩 고친다.
 *
 *   진단(diagnose)   뜻마다 GOAL.md 3절의 칸 중 무엇이 모자라는지, 어느 예문을 너무 많이 보여 줬는지
 *   대상(targets)    모자란 뜻을 우선순위대로 꺼낸다. 실행하는 쪽(ChatGPT)이 이것을 보고 고칠 내용을 만든다
 *   적용(apply)      여러 뜻을 한 번에 고친다. 승인 없이 바로 적용하고, 바꾸기 전 모습을 변경 기록에 남긴다
 *   기록(history)    최근 변경
 *   되돌리기(undo)   실행 한 번 또는 변경 하나를 되돌린다
 *
 * 지키는 것: 진도(ST#)는 건드리지 않는다. 합칠 때만 사람마다 학습량이 많은 쪽을 고른다(GOAL.md 5절).
 *           원문(src)과 등록 시각은 지우지 않는다. 서버는 검색하지 않는다(요즘 활용 문장은 받은 것을 저장한다).
 *
 *   CHANGE/<시각-번호>  { id, runId, at, kind: 'update'|'merge', senses[], summary[], exprs: [{ id, before, after }],
 *                       rows: [{ uid, id, before }], undoneAt? }
 */
import { randomBytes } from 'node:crypto';
import { Core } from '../shared/core.js';
import * as cat from './catalog.mjs';
import { InputError } from './service.mjs';

export const RULES = {
  minExamples: 8, maxExamples: 12, overexposed: 100, trendDays: 90, minWrong: 3, minTrends: 2, placeholderRepeat: 3,
  maxUpdates: 20, maxTargets: 15,
};
const DAY = 86400000;
/** 활용 문장을 실제 뉴스에 연결해야 하는 톤 */
const NEWSY = new Set(['news', 'finance', 'business', 'tech', 'economy', 'politics']);
/** 한국 시간 기준 날짜 (YYYY-MM-DD). 서버(Lambda)는 UTC 로 돈다 */
export const kstDate = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);

const GAP_KO = {
  no_register: '톤(register)이 없다',
  few_examples: `예문이 ${RULES.minExamples}개보다 적다 (목표 10개 안팎)`,
  unmarked_examples: '표현 부분에 [ ] 표시가 없는 예문이 있다',
  untranslated_examples: '한국어 번역이 없는 예문이 있다',
  no_contrasts: '뉘앙스 대비(헷갈리는 유의어, 언제 쓰나, 맞는 문장)가 없다',
  no_collocations: '자주 같이 쓰는 말이 없다',
  weak_wrong_meanings: `틀린 뜻 보기가 ${RULES.minWrong}개보다 적다`,
  weak_wrong_fills: `틀린 빈칸 보기가 ${RULES.minWrong}개보다 적다`,
  no_trends: '요즘 활용 문장이 없다',
  few_trends: `요즘 활용 문장이 ${RULES.minTrends}개보다 적다 (2~3개)`,
  untranslated_trends: '한국어 번역이 없는 요즘 활용 문장이 있다 (ko 는 그 문장의 번역)',
  unsourced_trends: '뉴스·금융·비즈니스·기술 톤인데 출처(source)나 링크(url)가 없는 활용 문장이 있다 (실제 뉴스를 검색해서 연결한다)',
  placeholder_trends: '활용 문장의 한국어 칸에 여러 뜻에 똑같이 들어간 문구가 있다 (자리 채우기가 아니라 그 문장의 번역을 쓴다)',
  weak_contrasts: '예문이나 번역이 빠진 뉘앙스 대비가 있다 (대비마다 그 표현이 맞는 문장과 번역)',
  stale_trends: `요즘 활용 문장이 ${RULES.trendDays}일보다 오래됐다`,
  overexposed_examples: `${RULES.overexposed}번 넘게 보여 준 예문이 있다 (같은 상황의 새 문장으로 바꾼다)`,
  wrapped_expression: '강조어가 붙은 조합이다 (핵심 표현으로 합치고 이 조합은 자주 같이 쓰는 말로)',
  has_wrapped_duplicates: '강조어가 붙은 같은 말이 따로 등록돼 있다 (이쪽으로 합친다)',
  no_ipa: '단어인데 발음기호가 없다',
};

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/** 이 단어장을 쓰는 사람들 (주인 + 초대받은 사람) */
async function uids(store) {
  return ['owner', ...(await store.listDocs('USER')).filter((u) => u.uid !== 'owner').map((u) => u.uid)];
}

/** 예문마다 보여 준 횟수. 모든 사람의 세션을 합친다. 키: `${뜻 ID}|${예문 키}` */
export async function exposureCounts(store) {
  const counts = new Map();
  for (const uid of await uids(store)) {
    for (const s of await store.listSessions(100000, uid)) {
      for (const e of s.ev || []) if (e.ex) counts.set(e.i + '|' + e.ex, (counts.get(e.i + '|' + e.ex) || 0) + 1);
    }
  }
  return counts;
}

export function diagnose(unit, counts, now, overlap = {}) {
  const ex = unit.examples || [], gaps = [];
  if (overlap.core) gaps.push('wrapped_expression');
  if (overlap.wrappers && overlap.wrappers.length) gaps.push('has_wrapped_duplicates');
  if (!unit.register) gaps.push('no_register');
  if (ex.length < RULES.minExamples) gaps.push('few_examples');
  if (ex.some((e) => !Core.exFill(e.en))) gaps.push('unmarked_examples');
  if (ex.some((e) => !e.ko)) gaps.push('untranslated_examples');
  if (!(unit.contrasts || []).length) gaps.push('no_contrasts');
  else if (unit.contrasts.some((c) => !c.en || !c.ko || !c.when_ko)) gaps.push('weak_contrasts');
  if (!(unit.collocations || []).length) gaps.push('no_collocations');
  if ((unit.wrong_meanings_ko || []).length < RULES.minWrong) gaps.push('weak_wrong_meanings');
  if (ex.some((e) => Core.exFill(e.en)) && (unit.wrong_fills || []).length < RULES.minWrong) gaps.push('weak_wrong_fills');
  const trends = unit.trends || [];
  if (!trends.length) gaps.push('no_trends');
  else {
    if (trends.length < RULES.minTrends) gaps.push('few_trends');
    if (trends.some((t) => !t.ko)) gaps.push('untranslated_trends');
    if (NEWSY.has(unit.register || '') && trends.some((t) => !t.source || !t.url)) gaps.push('unsourced_trends');
    if (overlap.placeholders && trends.some((t) => t.ko && overlap.placeholders.has(t.ko.trim()))) gaps.push('placeholder_trends');
    if (trends.every((t) => !t.date || now - Date.parse(t.date) > RULES.trendDays * DAY)) gaps.push('stale_trends');
  }
  const over = ex.map((e) => ({ key: Core.exKey(e.en), en: e.en, shown: counts.get(unit.id + '|' + Core.exKey(e.en)) || 0 }))
    .filter((e) => e.shown >= RULES.overexposed);
  if (over.length) gaps.push('overexposed_examples');
  if (unit.kind === 'word' && !unit.ipa) gaps.push('no_ipa');
  // 너무 많이 본 예문과 비어 있는 핵심 칸을 먼저 고친다
  const weight = { wrapped_expression: 4, has_wrapped_duplicates: 4, overexposed_examples: 3, placeholder_trends: 2, unsourced_trends: 2, few_examples: 2, no_contrasts: 2, no_trends: 2, stale_trends: 2, no_register: 2 };
  const score = gaps.reduce((a, g) => a + (weight[g] || 1), 0);
  return { gaps, over, score };
}

/** 고칠 뜻을 우선순위대로. 같은 점수면 오래 손대지 않은 것부터 */
export async function targets(store, { limit = 10, ids } = {}, now = Date.now()) {
  const [units, counts] = await Promise.all([cat.loadUnits(store), exposureCounts(store)]);
  // 강조어 조합 ↔ 핵심 표현
  const known = new Set(units.map((u) => Core.normText(u.text)));
  const exprByText = new Map(units.map((u) => [Core.normText(u.text), u.exprId]));
  // 활용 문장 한국어 칸에 여러 뜻에 똑같이 들어간 문구 = 자리 채우기
  const koSenses = new Map();
  units.forEach((u) => new Set((u.trends || []).map((t) => (t.ko || '').trim()).filter(Boolean)).forEach((ko) => koSenses.set(ko, (koSenses.get(ko) || 0) + 1)));
  const placeholders = new Set([...koSenses].filter(([, n]) => n >= RULES.placeholderRepeat).map(([ko]) => ko));
  const overlapOf = (u) => {
    const core = cat.coreOf(u.text, known);
    const wrappers = [...new Set(units.filter((x) => x.exprId !== u.exprId && cat.coreOf(x.text, known) === Core.normText(u.text)).map((x) => x.exprId))];
    return { core: core && core !== Core.normText(u.text) ? core : null, coreExprId: core ? exprByText.get(core) || null : null, wrappers, placeholders };
  };
  const pool = ids && ids.length ? units.filter((u) => ids.includes(u.id) || ids.includes(u.exprId)) : units.filter((u) => !u.pending);
  const diag = pool.map((u) => { const o = overlapOf(u); return { u, o, d: diagnose(u, counts, now, o) }; }).filter((x) => x.d.score > 0)
    .sort((a, b) => b.d.score - a.d.score || (a.u.refinedAt || 0) - (b.u.refinedAt || 0) || (a.u.createdAt || 0) - (b.u.createdAt || 0));
  const n = Math.max(1, Math.min(RULES.maxTargets, Number(limit) || 10));
  const byExpr = new Map(); units.forEach((u) => { if (!byExpr.has(u.exprId)) byExpr.set(u.exprId, []); byExpr.get(u.exprId).push(u); });
  return {
    today: kstDate(now),
    total_with_gaps: diag.length,
    targets: diag.slice(0, n).map(({ u, d, o }) => ({
      sense_id: u.id, expr_id: u.exprId, text: u.text, kind: u.kind, ipa: u.ipa || '', forms: u.forms || [],
      sense: `${u.senseNo}/${u.senseCount}`,
      other_senses: byExpr.get(u.exprId).filter((x) => x.id !== u.id).map((x) => ({ sense_id: x.id, meaning_ko: x.meaning_ko })),
      content: {
        meaning_ko: u.meaning_ko, register: u.register || '', note: u.note || '',
        examples: (u.examples || []).map((e) => ({ key: Core.exKey(e.en), en: e.en, ko: e.ko || '', shown: counts.get(u.id + '|' + Core.exKey(e.en)) || 0 })),
        synonyms: u.synonyms || [], antonyms: u.antonyms || [], contrasts: u.contrasts || [], collocations: u.collocations || [],
        wrong_meanings_ko: u.wrong_meanings_ko || [], wrong_fills: u.wrong_fills || [], trends: u.trends || [],
        source: u.src || null,
      },
      gaps: d.gaps.map((g) => ({ code: g, ko: GAP_KO[g] })),
      ...(o.core ? { core: { text: o.core, expr_id: o.coreExprId, senses: o.coreExprId ? byExpr.get(o.coreExprId).map((x) => ({ sense_id: x.id, meaning_ko: x.meaning_ko })) : [] } } : {}),
      ...(o.wrappers.length ? { wrapped_duplicates: o.wrappers.map((id) => ({ expr_id: id, senses: byExpr.get(id).map((x) => ({ sense_id: x.id, text: x.text, meaning_ko: x.meaning_ko })) })) } : {}),
      overexposed: d.over,
    })),
  };
}

/* ---------- 적용 ---------- */

function cleanExample(e, text) {
  if (!e || typeof e !== 'object') return null;
  const en = str(e.en, 400);
  return en ? { en: Core.autoMark(en, text), ko: str(e.ko, 400) } : null;
}
const strList = (v, max, len = 120) => (Array.isArray(v) ? [...new Set(v.map((x) => str(x, len)).filter(Boolean))].slice(0, max) : null);
function cleanContrasts(v) {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 4).map((c) => c && ({
    text: str(c.text, 80), when_ko: str(c.when_ko, 300),
    en: str(c.example && c.example.en != null ? c.example.en : c.en, 400), ko: str(c.example && c.example.ko != null ? c.example.ko : c.ko, 400),
  })).filter((c) => c && c.text);
}
function cleanTrends(v, text, now) {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 4).map((t) => t && {
    en: t.en ? Core.autoMark(str(t.en, 400), text) : '', ko: str(t.ko, 400), topic: str(t.topic, 120),
    source: str(t.source, 120), url: /^https?:\/\//.test(str(t.url, 500)) ? str(t.url, 500) : '',
    date: /^\d{4}-\d{2}-\d{2}/.test(str(t.date, 10)) ? str(t.date, 10) : kstDate(now),
  }).filter((t) => t && t.en);
}

/** 사람마다 두 진도 중 학습량이 많은 쪽 (본 횟수 → 반감기). 처음 학습 시각은 이른 쪽. 더하지 않는다 */
export function pickProgress(a, b) {
  const sa = a && a.st, sb = b && b.st;
  if (!sa) return sb || null;
  if (!sb) return sa;
  const win = (sa.seen || 0) !== (sb.seen || 0) ? ((sa.seen || 0) > (sb.seen || 0) ? sa : sb) : ((sa.h || 0) >= (sb.h || 0) ? sa : sb);
  const intro = [sa.intro, sb.intro].filter((x) => x != null);
  return { ...win, intro: intro.length ? Math.min(...intro) : win.intro };
}

async function logChange(store, doc) {
  const id = `${doc.at}-${randomBytes(3).toString('hex')}`;
  await store.putDoc('CHANGE', id, { id, ...doc });
  return id;
}

/** 뜻 하나를 다른 뜻에 합친다 (중복, 활용형으로 따로 등록된 것) */
async function mergeSense(store, srcId, tgtId, runId, now) {
  if (srcId === tgtId) throw new InputError(`${srcId}: 자기 자신에게 합칠 수 없습니다.`);
  const [srcExpr, tgtExpr0] = [await cat.getExpr(store, cat.exprIdOf(srcId)), await cat.getExpr(store, cat.exprIdOf(tgtId))];
  const src = srcExpr && cat.unitsOf(srcExpr).find((u) => u.id === srcId);
  if (!src) throw new InputError(`${srcId}: 없는 뜻입니다.`);
  const tgtExpr = srcExpr.id === (tgtExpr0 && tgtExpr0.id) ? srcExpr : tgtExpr0;
  const tgt = tgtExpr && cat.unitsOf(tgtExpr).find((u) => u.id === tgtId);
  if (!tgt) throw new InputError(`${tgtId}: 합칠 대상 뜻이 없습니다.`);
  const before = [clone(srcExpr), ...(tgtExpr === srcExpr ? [] : [clone(tgtExpr)])];

  const merged = Core.mergeItem(tgt, src);
  const keep = cat.senseFrom({
    ...merged, register: tgt.register || src.register,
    collocations: [...new Set([...(tgt.collocations || []), ...(src.collocations || [])])].slice(0, 8),
    contrasts: (tgt.contrasts || []).length ? tgt.contrasts : src.contrasts, trends: [...(tgt.trends || []), ...(src.trends || [])].slice(0, 4),
    refinedAt: now,
  }, tgt.id);
  delete keep.st;
  tgtExpr.senses = tgtExpr.senses.map((x) => (x.id === tgt.id ? keep : x));
  if (srcExpr !== tgtExpr) {
    const forms = new Set([...(tgtExpr.forms || []), ...(srcExpr.forms || [])]);
    const wrapped = cat.coreOf(srcExpr.text, new Set([Core.normText(tgtExpr.text)])) === Core.normText(tgtExpr.text);
    if (wrapped) { // so capable → capable: 활용형이 아니라 자주 같이 쓰는 말로 남긴다
      keep.collocations = [...new Set([srcExpr.text, ...(keep.collocations || [])])].slice(0, 8);
    } else if (Core.normText(srcExpr.text) !== Core.normText(tgtExpr.text)) forms.add(Core.normText(srcExpr.text));
    tgtExpr.forms = [...forms].slice(0, 12);
    tgtExpr.ipa = tgtExpr.ipa || srcExpr.ipa;
  }
  srcExpr.senses = srcExpr.senses.filter((x) => x.id !== srcId);

  // 진도: 사람마다 학습량이 많은 쪽을 합친 뜻에 둔다. 되돌리기용으로 바꾸기 전 행을 남긴다
  const rows = [];
  for (const uid of await uids(store)) {
    const a = await store.getStateRow(uid, srcId), b = await store.getStateRow(uid, tgtId);
    const st = pickProgress(a, b);
    if (st && canon(st) !== canon(b && b.st)) {
      rows.push({ uid, id: tgtId, before: clone(b) });
      await store.patchState(uid, tgtId, { st, ...(b && 'off' in b ? {} : a && 'off' in a ? { off: a.off } : {}) });
    }
  }
  await cat.saveExpr(store, tgtExpr);
  if (srcExpr !== tgtExpr) {
    if (srcExpr.senses.length) await cat.saveExpr(store, srcExpr);
    else await store.deleteDoc('EXPR', srcExpr.id);
  }
  await store.deleteItem(srcId); // 예전 ITEM 행이 남아 있으면 다시 보이지 않게
  const after = [srcExpr.senses.length || srcExpr === tgtExpr ? clone(srcExpr) : null, ...(tgtExpr === srcExpr ? [] : [clone(tgtExpr)])];
  const summary = [`${src.text} (${src.meaning_ko}) 를 ${tgt.text} (${tgt.meaning_ko}) 에 합침`, `진도를 옮긴 사람 ${rows.length}명`];
  const id = await logChange(store, { runId, at: now, kind: 'merge', senses: [srcId, tgtId], summary,
    exprs: before.map((b, i) => ({ id: b.id, before: b, after: after[i] })), rows, legacyItem: null });
  return { sense_id: srcId, merged_into: tgtId, change_id: id, changes: summary };
}

/** 뜻 하나의 내용을 고친다. 진도·원문·등록 시각은 건드리지 않는다 */
async function updateSense(store, u, runId, now, warnings) {
  const expr = await cat.getExpr(store, cat.exprIdOf(u.sense_id));
  const s = expr && expr.senses.find((x) => x.id === u.sense_id);
  if (!s) throw new InputError(`${u.sense_id}: 없는 뜻입니다.`);
  const before = clone(expr), changes = [], set = u.set || {}, text = expr.text;

  if (set.meaning_ko != null && str(set.meaning_ko, 200) && str(set.meaning_ko, 200) !== s.meaning_ko) { s.meaning_ko = str(set.meaning_ko, 200); changes.push('뜻 풀이'); }
  if (set.register != null && str(set.register, 20).toLowerCase() !== (s.register || '')) { s.register = str(set.register, 20).toLowerCase(); changes.push('톤'); }
  if (set.note != null && str(set.note, 600) !== (s.note || '')) { s.note = str(set.note, 600); changes.push('설명'); }
  for (const [k, max, ko] of [['collocations', 8, '자주 같이 쓰는 말'], ['wrong_meanings_ko', 6, '틀린 뜻 보기'], ['wrong_fills', 6, '틀린 빈칸 보기']]) {
    const v = strList(set[k], max); if (v) { s[k] = v; changes.push(ko); }
  }
  for (const [k, ko] of [['synonyms', '유의어'], ['antonyms', '반의어']]) if (Array.isArray(set[k])) { s[k] = Core.rel(set[k]); changes.push(ko); }
  const contrasts = cleanContrasts(set.contrasts); if (contrasts) { s.contrasts = contrasts; changes.push(`뉘앙스 대비 ${contrasts.length}개`); }
  const trends = cleanTrends(set.trends, text, now); if (trends) { s.trends = trends; changes.push(`요즘 활용 문장 ${trends.length}개`); }
  if (set.ipa != null && str(set.ipa, 60) !== (expr.ipa || '')) { expr.ipa = str(set.ipa, 60); changes.push('발음'); }
  if (Array.isArray(set.forms)) { expr.forms = [...new Set([...(expr.forms || []), ...set.forms.map(Core.normText).filter((f) => f && f !== Core.normText(text))])].slice(0, 12); changes.push('활용형'); }

  // 예문: 지우기 → 바꾸기 → 더하기. 원문 장면은 예문이 아니라 src 에 있으므로 건드리지 않는다
  let ex = (s.examples || []).slice();
  const keyOf = (e) => Core.exKey(e.en);
  const removeKeys = new Set(strList(u.remove_examples, 20, 20) || []);
  if (removeKeys.size) { const n = ex.length; ex = ex.filter((e) => !removeKeys.has(keyOf(e))); if (n !== ex.length) changes.push(`예문 ${n - ex.length}개 지움`); }
  let replaced = 0;
  for (const r of Array.isArray(u.replace_examples) ? u.replace_examples.slice(0, 12) : []) {
    const i = ex.findIndex((e) => keyOf(e) === str(r && r.key, 20)), ne = cleanExample(r, text);
    if (i === -1) warnings.push(`${u.sense_id}: 바꿀 예문 키 ${str(r && r.key, 20)} 가 없습니다.`);
    else if (ne) { ex[i] = ne; replaced++; }
  }
  if (replaced) changes.push(`예문 ${replaced}개 바꿈`);
  let added = 0;
  for (const a of Array.isArray(u.add_examples) ? u.add_examples.slice(0, 12) : []) {
    const ne = cleanExample(a, text);
    if (!ne || ex.some((e) => keyOf(e) === keyOf(ne))) continue;
    if (ex.length >= RULES.maxExamples) { warnings.push(`${u.sense_id}: 예문은 ${RULES.maxExamples}개까지라 나머지는 넣지 않았습니다.`); break; }
    ex.push(ne); added++;
  }
  if (added) changes.push(`예문 ${added}개 더함`);
  s.examples = ex;

  if (!changes.length) return { sense_id: u.sense_id, changes: [], change_id: null };
  s.refinedAt = now;
  await cat.saveExpr(store, expr);
  const after = clone(expr); delete after.legacy;
  const change_id = await logChange(store, { runId, at: now, kind: 'update', senses: [u.sense_id], summary: changes,
    exprs: [{ id: expr.id, before: before.legacy ? null : (delete before.legacy, before), after, fromLegacy: !!before.legacy }], rows: [] });
  return { sense_id: u.sense_id, change_id, changes };
}

/**
 * @param body { note?, updates: [{ sense_id, set?, add_examples?, replace_examples?, remove_examples?, merge_into? }] }
 */
export async function apply(store, body, now = Date.now()) {
  const updates = body && Array.isArray(body.updates) ? body.updates : null;
  if (!updates || !updates.length) throw new InputError('updates 배열이 필요합니다.');
  if (updates.length > RULES.maxUpdates) throw new InputError(`한 번에 ${RULES.maxUpdates}개까지 고칠 수 있습니다.`);
  const runId = `r${now}`, results = [], errors = [], warnings = [];
  for (const u of updates) {
    if (!u || !cat.UNIT_ID.test(String(u.sense_id || ''))) { errors.push(`${(u && u.sense_id) || '?'}: sense_id 가 올바르지 않습니다.`); continue; }
    try {
      results.push(u.merge_into ? await mergeSense(store, u.sense_id, String(u.merge_into), runId, now) : await updateSense(store, u, runId, now, warnings));
    } catch (e) {
      if (e instanceof InputError) errors.push(e.message); else throw e;
    }
  }
  if (body.note) await store.putDoc('RUN', runId, { runId, at: now, note: str(body.note, 300), changes: results.filter((r) => r.change_id).length });
  return { run_id: runId, results, errors, warnings };
}

/* ---------- 기록과 되돌리기 ---------- */

export async function history(store, { limit = 10 } = {}) {
  const all = (await store.listDocs('CHANGE')).sort((a, b) => b.at - a.at);
  const runs = new Map();
  for (const c of all) {
    if (!runs.has(c.runId)) runs.set(c.runId, { run_id: c.runId, at: new Date(c.at).toISOString(), changes: [] });
    runs.get(c.runId).changes.push({ change_id: c.id, kind: c.kind, senses: c.senses, summary: c.summary, undone: !!c.undoneAt });
  }
  return { runs: [...runs.values()].slice(0, Math.max(1, Math.min(30, Number(limit) || 10))) };
}

/** 실행 한 번(run_id) 또는 변경 하나(change_id)를 되돌린다. 그 뒤에 다시 바뀐 표현은 덮어쓰지 않고 알려 준다 */
export async function undo(store, { run_id, change_id } = {}, now = Date.now()) {
  if (!run_id && !change_id) throw new InputError('run_id 나 change_id 가 필요합니다.');
  const all = (await store.listDocs('CHANGE')).filter((c) => !c.undoneAt && (change_id ? c.id === change_id : c.runId === run_id))
    .sort((a, b) => b.at - a.at || (b.id < a.id ? -1 : 1));
  if (!all.length) throw new InputError('되돌릴 변경이 없습니다. rewinds_history 로 ID 를 확인하세요.');
  const done = [], skipped = [];
  for (const c of all) {
    const conflicts = [];
    for (const e of c.exprs) {
      const cur = await store.getDoc('EXPR', e.id);
      if (canon(cur) !== canon(e.after)) conflicts.push(e.id);
    }
    if (conflicts.length) { skipped.push({ change_id: c.id, reason: `그 뒤에 다시 바뀐 표현이 있어 되돌리지 않았습니다: ${conflicts.join(', ')}` }); continue; }
    for (const e of c.exprs) {
      if (e.before) await store.putDoc('EXPR', e.id, e.before);
      else if (e.fromLegacy) await store.deleteDoc('EXPR', e.id); // 예전 ITEM 행이 다시 보인다
      else await store.deleteDoc('EXPR', e.id);
    }
    for (const r of c.rows || []) await store.patchState(r.uid, r.id, r.before ? { st: r.before.st ?? null } : { st: null });
    await store.putDoc('CHANGE', c.id, { ...c, undoneAt: now });
    done.push({ change_id: c.id, summary: c.summary });
  }
  return { undone: done, skipped };
}
