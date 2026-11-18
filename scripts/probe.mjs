import fs from 'node:fs';
import { checkPromulgation, docName } from './promul.mjs';
const list = JSON.parse(fs.readFileSync('docs/data/bills.json', 'utf8')).filter((x) => ['정부', '행정규칙', '부처'].includes(x.source));
for (const x of list) {
  try { console.log('P|', x.source, '|', x.title.slice(0, 40), '|', docName(x.title), '|', JSON.stringify(await checkPromulgation(x))); }
  catch (e) { console.log('P| ERR', x.title, e.message); }
}
// 이미 공포된 것으로 확인 테스트: 전기사업법 시행령 (11/10 공포), 예고 시작 가정 10/1
console.log('P| TEST', JSON.stringify(await checkPromulgation({ source: '정부', title: '전기사업법 시행령 일부개정령안 입법예고', start: '2026-10-01' })));
console.log('P| TEST2', JSON.stringify(await checkPromulgation({ source: '행정규칙', title: '공공기관 에너지이용 합리화 추진에 관한 규정 일부개정안', start: '2026-04-01' })));
