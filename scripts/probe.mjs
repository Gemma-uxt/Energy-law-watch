const UA = { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,*/*' };
const u = 'https://www.law.go.kr/LSW/admRulSc.do?menuId=5&subMenuId=41&tabMenuId=183&query=' + encodeURIComponent('공공기관 에너지이용 합리화 추진에 관한 규정');
const t = await (await fetch(u, { headers: UA })).text();
const i = t.indexOf('2026-111'); console.log('P| idx', i, t.length);
console.log('P|', t.slice(i - 1500, i + 1200).replace(/\s+/g, ' '));
const srcs = [...new Set([...t.matchAll(/(admRul[A-Za-z]*\.do)/g)].map((m) => m[1]))]; console.log('P| do:', srcs.join(' '));
const k = t.indexOf('검색결과 목록'); console.log('P| list area', t.slice(k - 200, k + 1500).replace(/\s+/g, ' '));
