// 시행령·시행규칙·고시가 실제로 공포(발령)됐는지 국가법령정보센터에서 확인
// - 법령(시행령·시행규칙): 현행법령 검색 + '예정법령 포함'(공포됐지만 아직 시행 전인 것까지)
// - 행정규칙(고시·훈령 등): 현행행정규칙 검색
// 입법·행정예고를 시작한 날 이후에 공포(발령)된 같은 이름의 법령이 있으면 '공포됨'으로 봄
const UA = { 'User-Agent': 'Mozilla/5.0 (energy-law-watch)', Accept: 'text/html,*/*' };
const strip = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const norm = (s) => (s || '').replace(/[^가-힣A-Za-z0-9]/g, '');
const iso = (s) => { const m = (s || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };

// 예고 제목 → 법령·고시 이름 (예: '「OO규정」 고시 일부개정(안) 행정예고' → 'OO규정')
export function docName(t = '') {
  const m = t.match(/[「『]([^」』]+)[」』]/);
  let s = m ? m[1] : t;
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\s*(행정|입법)\s*예고.*$/, '');
  s = s.replace(/\s*(일부|전부)?\s*(개정|제정|폐지)\s*(령|고시|훈령|예규|규칙)?\s*안?.*$/, '');
  s = s.replace(/\s*(고시|훈령|예규|공고)\s*$/, '');
  return s.replace(/\s+/g, ' ').trim();
}

async function get(url) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(40000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      if (i >= 3) throw e;
      await new Promise((ok) => setTimeout(ok, 4000 * i));
    }
  }
}

// 검색 결과 표에서 [이름, 공포(발령)일, 시행일, 번호] 뽑기
function rowsOf(html, adm) {
  const body = (html.match(/<tbody>[\s\S]*?<\/tbody>/g) || []).find((b) => /(\d{4})\.\s*\d{1,2}\.\s*\d{1,2}\./.test(b)) || '';
  return (body.match(/<tr[\s\S]*?<\/tr>/g) || []).map((tr) => {
    const tds = (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(strip);
    if (adm) {   // 번호 | 이름 | 종류 | 발령번호 | 발령일 | 시행일 | 구분 | 부처
      return { name: tds[1], ancYd: iso(tds[4]), efYd: iso(tds[5]), no: `${tds[2] || ''} ${tds[3] || ''}`.trim(), kind: tds[6] };
    }        // 번호 | 이름 | 공포일 | 종류 | 공포번호 | 시행일 | 구분 | 부처
    return { name: tds[1], ancYd: iso(tds[2]), efYd: iso(tds[5]), no: `${tds[3] || ''} ${tds[4] || ''}`.trim(), kind: tds[6] };
  }).filter((r) => r.name && r.ancYd);
}

export async function checkPromulgation(item) {
  const name = docName(item.title);
  if (name.length < 4) return null;
  const adm = item.source === '행정규칙' || item.source === '부처';
  const q = encodeURIComponent(name);
  const url = adm
    ? `https://www.law.go.kr/LSW/admRulSc.do?menuId=5&subMenuId=41&tabMenuId=183&query=${q}`
    : `https://www.law.go.kr/LSW/lsSc.do?menuId=1&subMenuId=15&tabMenuId=81&efCheck=Y&query=${q}`;
  const rows = rowsOf(await get(url), adm).filter((r) => norm(r.name) === norm(name));
  const since = iso(item.start) || iso(item.posted) || (item.first_seen || '').slice(0, 10);
  const hit = rows.filter((r) => r.ancYd >= since).sort((a, b) => a.ancYd.localeCompare(b.ancYd))[0];
  return { name, found: rows.length, done: !!hit, ancYd: hit?.ancYd || '', efYd: hit?.efYd || '', no: hit?.no || '', url };
}
