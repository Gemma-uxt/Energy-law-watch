// 에너지 관련 입법예고 수집기 (GitHub Actions에서 실행됨)
import fs from 'node:fs';

const KW = JSON.parse(fs.readFileSync('scripts/keywords.json', 'utf8'));
const DATA = 'docs/data/bills.json';
const META = 'docs/data/meta.json';
const NEWF = 'docs/data/new.json';
const ASSEMBLY_KEY = (process.env.ASSEMBLY_API_KEY || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const GOV = 'https://opinion.lawmaking.go.kr';
const UA = { 'User-Agent': 'Mozilla/5.0 (energy-law-watch)' };
const NOW = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const TODAY = NOW.slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 공통 도구 ----------
async function get(url, asJson = false) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return asJson ? await r.json() : await r.text();
    } catch (e) {
      console.log(`  ! 요청 실패(${i}/3): ${e.message}`);
      await sleep(5000 * i);
    }
  }
  throw new Error('요청 최종 실패: ' + url);
}

const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&middot;/g, '·')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

const htmlToText = (html) => decode(html
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '\n'))
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

const clean = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const toISO = (s) => {
  const m = (s || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
};

function classify(text = '') {
  let t = text;
  for (const ex of KW.exclude) t = t.split(ex).join('');
  t = t.toLowerCase();
  return Object.entries(KW.categories)
    .filter(([, kws]) => kws.some((k) => t.includes(k.toLowerCase())))
    .map(([c]) => c);
}

// ---------- 국회: 진행중 입법예고 (열린국회정보 API) ----------
async function fetchAssembly() {
  if (!ASSEMBLY_KEY) { console.log('[국회] ASSEMBLY_API_KEY 없음, 건너뜀'); return []; }
  const code = 'nknalejkafmvgzmpt';
  let rows = [];
  for (let p = 1; p <= 50; p++) {
    const url = `https://open.assembly.go.kr/portal/openapi/${code}` +
      `?KEY=${encodeURIComponent(ASSEMBLY_KEY)}&Type=json&pIndex=${p}&pSize=100`;
    const j = await get(url, true);
    const block = j[code];
    if (!block) { console.log('[국회] 응답:', JSON.stringify(j.RESULT || j)); break; }
    const total = Number(block[0].head[0].list_total_count);
    rows = rows.concat(block[1].row || []);
    if (rows.length >= total) break;
  }
  console.log(`[국회] 진행중 입법예고 ${rows.length}건`);
  return rows.map((r) => ({
    id: `NA-${r.BILL_ID}`,
    source: '국회',
    title: r.BILL_NAME || '',
    proposer: r.PROPOSER || '',
    org: r.CURR_COMMITTEE || '',
    field: '',
    start: '',
    end: r.NOTI_ED_DT || '',
    link: r.LINK_URL || '',
    bill_id: r.BILL_ID || '',
  }));
}

async function fetchAssemblyBody(item) {
  const urls = [item.link];
  if (item.bill_id) urls.push(`https://likms.assembly.go.kr/bill/billDetail.do?billId=${item.bill_id}`);
  for (const u of urls.filter(Boolean)) {
    try {
      const m = htmlToText(await get(u)).match(/제안이유[\s\S]{30,4000}/);
      if (m) return m[0].slice(0, 4000).trim();
    } catch {}
  }
  return '';
}

// ---------- 정부: 국민참여입법센터 (부처)입법예고 목록 페이지 ----------
async function fetchGov(maxPages = 15) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const html = await get(`${GOV}/gcom/ogLmPp?pageIndex=${page}`);
    const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    let added = 0;
    for (const tr of rows) {
      const m = tr.match(/\/gcom\/ogLmPp\/(\d+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => clean(x[1]));
      const tm = tr.match(/title="([^"]+)"/);
      const orgKind = tds[2] || '';                       // 예: 국토교통부 (대통령령)
      const km = orgKind.match(/^(.*?)\s*\((.*?)\)\s*$/);
      const period = (tds[4] || '').match(/\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\./g) || [];
      out.push({
        id: `GOV-${m[1]}`,
        source: '정부',
        title: tm ? decode(tm[1]) : (tds[1] || ''),
        proposer: km ? km[1] : orgKind,
        org: km ? km[2] : '',
        field: tds[3] || '',
        start: period[0] || '',
        end: period[1] || '',
        link: `${GOV}/gcom/ogLmPp/${m[1]}`,
      });
      added++;
    }
    console.log(`[정부] ${page}페이지: ${added}건`);
    if (!added) break;
    await sleep(1000);
  }
  console.log(`[정부] 진행중 입법예고 ${out.length}건`);
  return out;
}

async function fetchGovBody(item) {
  try {
    const t = htmlToText(await get(item.link));
    const m = t.match(/(개정이유|제정이유)[\s\S]{30,5000}?(?=의견제출|$)/);
    return m ? m[0].slice(0, 4000).trim() : '';
  } catch { return ''; }
}

// ---------- (선택) Claude 요약 ----------
async function summarize(item) {
  if (!ANTHROPIC_KEY || !item.body) return '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content:
          '다음 법안을 에너지 업계 실무자 관점에서 3문장으로 요약해줘. ' +
          '핵심 변경사항과 영향받는 주체 위주로, 불릿 없이.\n\n' +
          `제목: ${item.title}\n\n${item.body}` }],
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return (j.content?.[0]?.text || '').trim();
  } catch (e) {
    console.log('  ! 요약 실패:', e.message);
    return '';
  }
}

// ---------- 실행 ----------
const old = new Map();
if (fs.existsSync(DATA)) {
  for (const x of JSON.parse(fs.readFileSync(DATA, 'utf8') || '[]')) old.set(x.id, x);
}

let fetched = [];
const ok = new Set();
for (const [name, fn] of [['국회', fetchAssembly], ['정부', fetchGov]]) {
  try {
    const items = await fn();
    fetched = fetched.concat(items);
    if (items.length) ok.add(name);
  } catch (e) {
    console.log(`[${name}] 수집 실패 → 기존 데이터 유지: ${e.message}`);
  }
}

const current = new Set();
const newItems = [];
for (const it of fetched) {
  let cats = classify(`${it.title} ${it.field}`);
  if (!cats.length) continue;
  current.add(it.id);
  const prev = old.get(it.id);
  if (prev) {
    for (const [k, v] of Object.entries(it)) if (v) prev[k] = v;
    continue;
  }
  it.body = it.source === '국회' ? await fetchAssemblyBody(it) : await fetchGovBody(it);
  cats = [...new Set([...cats, ...classify(it.body)])].sort();
  Object.assign(it, { categories: cats, summary: await summarize(it), first_seen: NOW });
  old.set(it.id, it);
  newItems.push(it);
  console.log(`  NEW [${it.source}] ${it.title} (${cats.join(', ')})`);
  await sleep(500);
}

// 진행/종료 판정: 종료일이 있으면 날짜로, 없으면 목록에 남아 있는지로
for (const v of old.values()) {
  const end = toISO(v.end);
  if (end) v.status = end < TODAY ? '종료' : '진행';
  else if (ok.has(v.source)) v.status = current.has(v.id) ? '진행' : '종료';
  else v.status = v.status || '진행';
}

fs.mkdirSync('docs/data', { recursive: true });
const list = [...old.values()].sort((a, b) => (b.first_seen || '').localeCompare(a.first_seen || ''));
fs.writeFileSync(DATA, JSON.stringify(list, null, 1));
fs.writeFileSync(META, JSON.stringify({ updated: NOW, sources: [...ok] }));
fs.writeFileSync(NEWF, JSON.stringify(newItems, null, 1));
console.log(`신규 ${newItems.length}건 / 누적 ${old.size}건`);
