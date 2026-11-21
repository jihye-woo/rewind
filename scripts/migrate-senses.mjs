/**
 * 단어장을 "표현 → 뜻" 구조로 옮긴다 (docs/GOAL.md 7절 1번).
 *
 *   TABLE_NAME=rewind node scripts/migrate-senses.mjs            미리보기: 무엇이 바뀌는지 보여 주기만 한다
 *   TABLE_NAME=rewind node scripts/migrate-senses.mjs --apply    실제로 옮긴다
 *
 * 하는 일
 *   1. 아직 옮기지 않은 ITEM 행마다 뜻 하나짜리 EXPR 행을 만든다. 뜻 ID = 예전 항목 ID 라서 진도·세션은 그대로 이어진다.
 *   2. 주인의 예전 진도(항목 문서 안의 st)를 사람별 진도 행(ST#owner)으로 옮긴다. 이미 행에 진도가 있으면 그쪽을 둔다.
 *   3. 뜻 문서에는 진도를 남기지 않는다(정제가 진도를 건드리지 않도록).
 * 하지 않는 일: ITEM 행 지우기(되돌리기용으로 남긴다), 중복·활용형 합치기, 뜻 나누기(정제 도구가 한다)
 * 여러 번 돌려도 결과가 같다. --apply 뒤에는 옮기기 전과 후에 주인이 보는 항목(내용·진도·켜짐)이 같은지 확인한다.
 */
import { pathToFileURL } from 'node:url';
import { createDynamoStore } from '../server/store-dynamo.mjs';
import * as cat from '../server/catalog.mjs';
import * as service from '../server/service.mjs';

const OWNER = { uid: 'owner', role: 'owner', name: '주인' };
/** 키 순서와 관계없이 같은 값이면 같은 문자열 */
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

/** @returns {Promise<{plan: object, same?: boolean, before: number, after?: number}>} */
export async function migrate(store, { apply = false, log = console.log } = {}) {
const snapshot = async () => (await service.getState(store, OWNER)).items
  .map(({ senseNo, senseCount, exprId, forms, register, ...u }) => u)
  .sort((a, b) => a.id.localeCompare(b.id));

const before = await snapshot();
const [exprRows, legacy] = await Promise.all([store.listDocs('EXPR'), store.listItems()]);
const taken = new Set(exprRows.flatMap((e) => [e.id, ...e.senses.map((s) => s.id)]));
const toMove = legacy.filter((i) => !taken.has(i.id));
const work = exprRows.map((e) => ({ expr: e, isNew: false })).concat(toMove.map((i) => ({ expr: cat.legacyToExpr(i), isNew: true })));

const plan = { newExpr: 0, progressRows: 0, progressKept: 0, stripped: 0, examples: 0, samples: [] };
for (const { expr, isNew } of work) {
  if (isNew) plan.newExpr++;
  for (const s of expr.senses) {
    plan.examples += (s.examples || []).length;
    if (s.st === undefined) continue;
    plan.stripped++;
    if (s.st == null) continue;
    const row = await store.getStateRow('owner', s.id);
    if (row && row.st !== undefined) plan.progressKept++;
    else { plan.progressRows++; s._moveSt = s.st; }
  }
  if (isNew && plan.samples.length < 3) plan.samples.push({ from: `ITEM/${expr.id}`, to: `EXPR/${expr.id}`, senses: expr.senses.map((s) => `${s.id}: ${s.meaning_ko}`) });
}

log(`예전 ITEM 행 ${legacy.length}개 · 이미 EXPR ${exprRows.length}개 · 이번에 옮길 것 ${plan.newExpr}개`);
log(`주인 진도: 사람별 진도 행으로 옮길 것 ${plan.progressRows}개, 이미 행이 있어 그대로 둘 것 ${plan.progressKept}개`);
log(`뜻 문서에서 진도 칸을 뺄 것 ${plan.stripped}개 · 예문 합계 ${plan.examples}개`);
log('예시:', JSON.stringify(plan.samples, null, 1));
if (!apply) { log('\n미리보기만 했습니다. 실제로 옮기려면 --apply 를 붙이세요.'); return { plan, before: before.length }; }

for (const { expr } of work) {
  let changed = false;
  for (const s of expr.senses) {
    if (s._moveSt !== undefined) { await store.patchState('owner', s.id, { st: s._moveSt }); delete s._moveSt; }
    if (s.st !== undefined) { delete s.st; changed = true; }
  }
  if (expr.legacy || changed) await cat.saveExpr(store, expr);
}

const after = await snapshot();
const same = canon(before) === canon(after);
log(`\n옮겼습니다. 확인: 항목 ${before.length} → ${after.length}, 주인이 보는 내용·진도·켜짐 ${same ? '같음' : '다름!'}`);
if (!same) {
  const b = Object.fromEntries(before.map((u) => [u.id, canon(u)]));
  after.filter((u) => b[u.id] !== canon(u)).slice(0, 5).forEach((u) => log('  다름:', u.id));
}
return { plan, same, before: before.length, after: after.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) { console.error('TABLE_NAME 을 주세요 (terraform -chdir=infra output -raw table_name)'); process.exit(1); }
  console.log(`표: ${tableName}`);
  const r = await migrate(createDynamoStore({ tableName }), { apply: process.argv.includes('--apply') });
  if (r.same === false) process.exit(2);
}
