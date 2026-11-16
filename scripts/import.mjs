/**
 * 백업 파일을 서버에 되살린다. 앱의 "전체 기록 백업 받기"로 받은 파일이나 data/prototype-export.json 을 넣는다.
 *
 *   APP_KEY=<앱 키> node scripts/import.mjs https://example.com/english data/prototype-export.json
 *   APP_KEY=dev-app-key node scripts/import.mjs http://localhost:8787 data/prototype-export.json   (로컬)
 *
 * 이미 있는 항목은 건너뛴다. 덮어쓰려면 끝에 --overwrite 를 붙인다.
 * 앱 키는 `terraform -chdir=infra output -raw app_url` 로 나오는 주소에서 #key= 뒤의 값이다.
 */
import { readFile } from 'node:fs/promises';

const [base, file, flag] = process.argv.slice(2);
const key = process.env.APP_KEY;
if (!base || !file || !key) {
  console.error('사용법: APP_KEY=<앱 키> node scripts/import.mjs <앱 주소> <백업 파일> [--overwrite]');
  process.exit(1);
}
const data = JSON.parse(await readFile(file, 'utf8'));
const body = JSON.stringify({ data, overwrite: flag === '--overwrite' });
if (Buffer.byteLength(body) > 250 * 1024) {
  console.error('파일이 한 번에 보낼 수 있는 크기(250KB)를 넘습니다. items 와 sessions 를 나눠서 여러 번 실행하세요.');
  process.exit(1);
}
// 서비스 경로(/english)를 살리려고 끝에 / 를 붙이고 상대 경로로 잇는다
const res = await fetch(new URL('api/import', base.replace(/\/?$/, '/')), { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body });
const out = await res.json().catch(() => null);
if (!res.ok) { console.error(`실패 (${res.status}):`, out && out.error); process.exit(1); }
console.log(`항목: ${out.items.imported}개 넣음, ${out.items.skipped}개 건너뜀(이미 있음), ${out.items.rejected.length}개 거절`);
console.log(`세션: ${out.sessions.imported}개 넣음, ${out.sessions.rejected.length}개 거절`);
[...out.items.rejected, ...out.sessions.rejected].forEach((m) => console.log('  거절: ' + m));
