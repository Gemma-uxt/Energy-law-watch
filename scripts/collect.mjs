// 에너지 입법·행정예고 수집기 + 인사이트 생성 (GitHub Actions에서 실행)
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const KW = JSON.parse(fs.readFileSync('scripts/keywords.json', 'utf8'));
const BOARDS = fs.existsSync('scripts/boards.json') ? JSON.parse(fs.readFileSync('scripts/boards.json', 'utf8')) : [];
const PROFILE = fs.existsSync('scripts/profile.txt') ? fs.readFileSync('scripts/profile.txt', 'utf8').trim() : '';
const DATA = 'docs/data/bills.json';
const META = 'docs/data/meta.json';
const NEWF = 'docs/data/new.json';
const INS = 'docs/data/insights.json';
const ASSEMBLY_KEY = (process.env.ASSEMBLY_API_KEY || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
const AI_MAX = 40; // 한 번 실행에 분석할 최대 건수 (무료 한도 보호)
const GOV = 'https://opinion.lawmaking.go.kr';
const UA = { 'User-Agent': 'Mozilla/5.0 (energy-law-watch)' };
const NOW = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const TODAY = NOW.slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (iso, d) => new Date(Date.parse(iso) + d * 864e5).toISOString().slice(0, 10);

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

// ---------- 단계(법이 되기까지의 거리)와 기준 법령 ----------
const ST = {
  done: { order: 0, label: '확정·시행', speed: '이미 확정', note: '규칙개정위원회·전기위원회 심의와 장관 승인을 거쳐 공고·시행되는 규칙' },
  adm: { order: 1, label: '고시·훈령 등', speed: '가장 빠름(수주~수개월)', note: '국회를 거치지 않고 부처가 확정해 발령하는 행정규칙' },
  low: { order: 2, label: '시행령·시행규칙', speed: '빠름(보통 수개월)', note: '국회 의결 없이 규제·법제처 심사와 국무회의(부령은 장관 발령)로 확정' },
  law: { order: 3, label: '정부 법률안', speed: '중기(국회 심사 필요)', note: '입법예고 뒤 국무회의를 거쳐 국회에 제출되며, 국회 통과가 남아 있음' },
  na: { order: 4, label: '국회 법률안', speed: '장기·불확실', note: '상임위·법사위·본회의를 모두 통과해야 하며, 상당수는 대안에 흡수되거나 임기만료로 폐기됨' },
};
function stageOf(x) {
  const t = x.title || '';
  const isLaw = /법률안|법\s*(일부|전부)?\s*개정안|법\s*제정안/.test(t) && !/시행령|시행규칙/.test(t);
  if (x.source === '국회') return ST.na;
  if (/전력거래소/.test(x.proposer || '')) return ST.done;
  if (x.source === '정부') return isLaw ? ST.law : ST.low;
  if (x.source === '부처') return /시행령|시행규칙/.test(t) ? ST.low : isLaw ? ST.law : ST.adm;
  return ST.adm;
}
function lawOf(t = '') {
  const m = t.match(/[「『]([^」』]+)[」』]/);
  let s = (m ? m[1] : t).replace(/\(안\)/g, '').replace(/\([^)]*\d{4}[^)]*\)/g, '');
  s = s.replace(/\s*(일부|전부)?\s*(개정|제정|폐지).*$/, '').replace(/\s*(행정|입법)예고.*$/, '');
  return s.replace(/\s*(시행령|시행규칙)$/, '').replace(/\s+/g, ' ').trim();
}

// ---------- 국회: 진행중 입법예고 ----------
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
    id: `NA-${r.BILL_ID}`, source: '국회',
    title: r.BILL_NAME || '', proposer: r.PROPOSER || '',
    org: r.CURR_COMMITTEE || '', field: '',
    start: '', end: r.NOTI_ED_DT || '',
    link: r.LINK_URL || '', bill_id: r.BILL_ID || '',
  }));
}

async function fetchAssemblyBody(item) {
  const urls = [item.link];
  if (item.bill_id) urls.push(`https://likms.assembly.go.kr/bill/billDetail.do?billId=${item.bill_id}`);
  for (const u of urls.filter(Boolean)) {
    try {
      const m = htmlToText(await get(u))
        .match(/제안이유[\s\S]{30,4000}?(?=의견제출 방법|의견등록|입법예고 목록보기|$)/);
      if (m) return m[0].slice(0, 4000).trim();
    } catch {}
  }
  return '';
}

// ---------- 정부: 입법예고 (법령) ----------
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
      const orgKind = tds[2] || '';
      const km = orgKind.match(/^(.*?)\s*\((.*?)\)\s*$/);
      const period = (tds[4] || '').match(/\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\./g) || [];
      out.push({
        id: `GOV-${m[1]}`, source: '정부',
        title: tm ? decode(tm[1]) : (tds[1] || ''),
        proposer: km ? km[1] : orgKind, org: km ? km[2] : '',
        field: tds[3] || '',
        start: period[0] || '', end: period[1] || '',
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
    if (/(\.\.\.|…)$/.test(item.title)) {
      const p = item.title.replace(/(\.\.\.|…)$/, '').trim();
      const full = t.split('\n').map((s) => s.trim()).find((s) => s.startsWith(p) && s.length > p.length);
      if (full) item.title = full.slice(0, 200);
    }
    const m = t.match(/((제정|개정|폐지)\s*(이유|사유)|주요\s*내용)[\s\S]{30,5000}?(?=의견\s*제출|$)/);
    return m ? m[0].slice(0, 4000).trim() : '';
  } catch { return ''; }
}

// ---------- 정부: (부처)행정예고 = 고시·훈령·예규·지침 ----------
async function fetchAdm(maxPages = 10) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const html = await get(`${GOV}/gcom/admpp?pageIndex=${page}`);
    const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    let found = 0, live = 0;
    for (const tr of rows) {
      const m = tr.match(/\/gcom\/admpp\/(\d+)([^"'\s]*)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      found++;
      const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => clean(x[1]));
      const period = (tds[4] || '').match(/\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\./g) || [];
      const end = period[1] || '';
      if (end && toISO(end) < TODAY) continue;
      live++;
      const tm = tr.match(/title="([^"]+)"/);
      const title = (tm ? decode(tm[1]) : (tds[1] || ''))
        .replace(/\s*이동$/, '').replace(/^(진행|종료|마감)\s*/, '').trim();
      const om = (tds[3] || '').match(/^(.*?)\s*\((.*?)\)\s*$/);
      const query = decode(m[2]).replace(/[&?]pageIndex=\d+/, '');
      out.push({
        id: `ADM-${m[1]}`, source: '행정규칙',
        title, proposer: om ? om[1] : (tds[3] || ''),
        org: tds[2] || '', field: om ? om[2] : '',
        start: period[0] || '', end,
        link: `${GOV}/gcom/admpp/${m[1]}${query}`,
      });
    }
    console.log(`[행정규칙] ${page}페이지: 진행 ${live}건`);
    if (!found || !live) break;
    await sleep(1000);
  }
  console.log(`[행정규칙] 진행중 행정예고 ${out.length}건`);
  return out;
}

// ---------- 부처·기관 홈페이지 게시판 (관보 미게재분 등) ----------
async function fetchBoards() {
  const out = [];
  for (const b of BOARDS) {
    let n = 0;
    const re = new RegExp(b.link, 'i');
    const only = b.only ? new RegExp(b.only) : null;
    const seen = new Set();
    for (let p = 1; p <= (b.pages || 1); p++) {
      const url = p === 1 ? b.url
        : `${b.url}${b.url.includes('?') ? '&' : '?'}${b.pageParam || 'pageIndex'}=${p}`;
      let added = 0;
      try {
        const html = await get(url);
        const blocks = html.match(/<tr[\s\S]*?<\/tr>/gi) || html.match(/<li[\s\S]*?<\/li>/gi) || [];
        for (const blk of blocks) {
          const a = (blk.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || []).find((x) => re.test(x));
          if (!a) continue;
          const href = decode((a.match(/href="([^"]+)"/i) || [])[1] || '');
          if (!href || href.startsWith('#') || /^javascript/i.test(href)) continue;
          const link = new URL(href, url).href.replace(/;jsessionid=[^?#]*/i, '')
            .replace(/([?&])(pageIndex|nPage|lcmspage)=\d+&?/g, '$1');
          if (seen.has(link)) continue;
          seen.add(link);
          added++;
          const title = clean(a).replace(/\s*(새\s*창|새창열림|첨부파일).*$/, '').trim();
          if (title.length < 5 || (only && !only.test(title))) continue;
          const ds = [...clean(blk.replace(a, '')).matchAll(/(20\d{2})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})/g)]
            .map((m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
          const posted = ds[0] || '';
          const end = b.period && ds[1] ? ds[1] : '';
          if (end && end < TODAY) continue;
          if (!end && posted && (Date.parse(TODAY) - Date.parse(posted)) / 864e5 > (b.days || 45)) continue;
          out.push({
            id: 'MIN-' + createHash('md5').update(link).digest('hex').slice(0, 12),
            source: '부처', title, proposer: b.name, org: b.kind || '행정예고(부처 게시판)',
            field: b.cat || '', start: posted, end, posted, link,
            cat: b.cat || '', noDeadline: !!b.noDeadline,
          });
          n++;
        }
      } catch (e) { console.log(`  ! [부처] ${b.name} ${p}페이지 실패: ${e.message}`); }
      if (!added) break;
      await sleep(1000);
    }
    console.log(`[부처] ${b.name}${b.kind ? `(${b.kind})` : ''}: ${n}건`);
  }
  return out;
}

async function fetchBoardBody(item) {
  try {
    const t = htmlToText(await get(item.link));
    if (/(\.\.\.|…)$/.test(item.title)) {
      const p = item.title.replace(/(\.\.\.|…)$/, '').trim();
      const full = t.split('\n').map((s) => s.trim()).find((s) => s.startsWith(p) && s.length > p.length);
      if (full) item.title = full.slice(0, 200);
    }
    if (!item.end && !item.noDeadline) {
      const dl = t.match(/(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*까지/);
      item.end = dl ? `${dl[1]}-${dl[2].padStart(2, '0')}-${dl[3].padStart(2, '0')}`
        : (item.posted ? addDays(item.posted, 20) : '');
    }
    const m = t.match(/((제정|개정|폐지)\s*(이유|사유)|주요\s*내용)[\s\S]{30,5000}?(?=의견\s*제출|$)/);
    if (m) return m[0].slice(0, 4000).trim();
    for (const key of ['행정절차법', '알려드리오니', '회의결과']) {
      const i = t.indexOf(key);
      if (i >= 0) return t.slice(Math.max(0, i - 300), i + 2500).trim();
    }
    return '';
  } catch { return ''; }
}

const normT = (s) => (s || '').replace(/[^가-힣A-Za-z0-9]/g, '')
  .replace(/행정예고|입법예고|일부개정|전부개정|개정|제정|폐지|고시|훈령|예규|지침/g, '').replace(/안$/, '');

// ---------- Gemini (무료 등급) ----------
async function gemini(prompt) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
          }),
        });
      if (r.status === 429) { console.log('  ! Gemini 한도 초과, 잠시 대기'); await sleep(30000 * i); continue; }
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      const out = JSON.parse(text.replace(/^\s*```(json)?/, '').replace(/```\s*$/, ''));
      await sleep(4000);
      return out;
    } catch (e) {
      console.log(`  ! 요약 실패(${i}/3): ${e.message}`);
      await sleep(3000);
    }
  }
  return null;
}

const WHO = ['발전사', '전력판매·한전', '집단에너지사업자', '재생에너지사업자', '가스·석유사업자', '원자력',
  '수소사업자', '전력다소비 기업', '일반소비자', '지자체', '정부·공공기관', '기타'];
const DIR = ['규제강화', '규제완화', '지원·인센티브', '시장제도 변경', '절차·행정', '기타'];
direction 판단 기준: 규제받는 대상(사업자·기관·국민)의 의무·제한이 늘거나 엄격해지면 '규제강화', 줄거나 느슨해지면 '규제완화'. 온도·수치 기준은 대상이 더 자유롭게 행동할 수 있게 바뀌면 완화(예: 냉방 28℃→26℃, 난방 18℃→20℃는 완화). 강화와 완화가 섞이면 비중이 큰 쪽을 고르고, importance_reason에 섞여 있다고 적을 것.

let aiCalls = 0;
async function summarize(item) {
  if (!GEMINI_KEY || !item.body || item.body.length < 150 || aiCalls >= AI_MAX) return null;
  aiCalls++;
  const st = stageOf(item);
  const prompt =
`너는 에너지 분야 법률·정책 분석가야. 아래 원문을 읽고 JSON으로만 답해.
이 문서의 입법 단계: ${st.label} (${st.note})
형식:
{"oneline":"핵심 한 문장(60자 이내)",
 "reason":"개정(제정) 이유 2~3문장",
 "points":["주요 내용, 각 50자 이내, 최대 5개"],
 "impact":"영향과 실무 시사점 1~2문장",
 "who":["영향받는 주체. 다음 중에서만 고를 것: ${WHO.join(', ')}"],
 "direction":"다음 중 하나: ${DIR.join(', ')}",
 "importance":"1~3 숫자 (3=시장·사업에 직접적인 큰 변화, 2=의미 있는 변화, 1=경미하거나 기술적 정비)",
 "importance_reason":"중요도 판단 근거 1문장",
 "watch":"실무자가 지금 확인하거나 준비할 점 1문장"${PROFILE ? `,
 "fit":"아래 '우리 관점'에서 본 영향 1문장 (관련이 적으면 '직접 관련 낮음')"` : ''}}
원문에 없는 내용은 지어내지 말고, 알 수 없으면 빈 값으로 둬.
direction 판단 기준: 규제받는 대상(사업자·기관·국민)의 의무·제한이 늘거나 엄격해지면 '규제강화', 줄거나 느슨해지면 '규제완화'. 온도·수치 기준은 대상이 더 자유롭게 행동할 수 있게 바뀌면 완화(예: 냉방 28℃→26℃, 난방 18℃→20℃는 완화). 강화와 완화가 섞이면 비중이 큰 쪽을 고르고, importance_reason에 섞여 있다고 적을 것.${PROFILE ? `\n\n우리 관점: ${PROFILE}` : ''}

제목: ${item.title}
원문:
${item.body}`;
  const s = await gemini(prompt);
  if (s) {
    s.v = 3;
    s.importance = Math.min(3, Math.max(1, parseInt(s.importance, 10) || 1));
    if (!Array.isArray(s.who)) s.who = [];
    if (!Array.isArray(s.points)) s.points = s.points ? [String(s.points)] : [];
  }
  return s;
}

// ---------- 인사이트 집계 ----------
function buildInsights(list) {
  const dateOf = (x) => toISO(x.start) || (x.first_seen || '').slice(0, 10);
  const weeks = [];
  for (let i = 11; i >= 0; i--) weeks.push({ from: addDays(TODAY, -7 * i - 6), to: addDays(TODAY, -7 * i), total: 0, cats: {} });
  for (const x of list) {
    const d = dateOf(x);
    const w = weeks.find((w) => d >= w.from && d <= w.to);
    if (!w) continue;
    w.total++;
    for (const c of x.categories || []) w.cats[c] = (w.cats[c] || 0) + 1;
  }
  const momentum = Object.keys(KW.categories).map((c) => {
    const recent = weeks.slice(-4).reduce((a, w) => a + (w.cats[c] || 0), 0);
    const before = weeks.slice(0, 8).reduce((a, w) => a + (w.cats[c] || 0), 0) / 2;
    return { cat: c, recent, before: Math.round(before * 10) / 10 };
  }).filter((m) => m.recent || m.before);

  const since = addDays(TODAY, -180);
  const groups = {};
  for (const x of list) {
    if (!x.law || x.law.length < 3 || dateOf(x) < since) continue;
    (groups[x.law] ||= []).push(x);
  }
  const hot = Object.entries(groups).filter(([, a]) => a.length >= 2)
    .map(([law, a]) => ({
      law, count: a.length,
      stages: [...new Set(a.sort((p, q) => q.stage.order - p.stage.order).map((x) => x.stage.label))],
      items: a.slice(0, 6).map((x) => ({ title: x.title, source: x.source, status: x.status, link: x.link })),
    }))
    .sort((a, b) => b.count - a.count).slice(0, 10);

  const live = list.filter((x) => x.status === '진행');
  const stages = {};
  for (const x of live) (stages[x.stage.label] ||= { ...x.stage, n: 0 }).n++;
  const tally = (arr) => Object.entries(arr.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1]);
  return {
    updated: NOW, weeks, momentum, hot,
    stages: Object.values(stages).sort((a, b) => a.order - b.order),
    who: tally(live.flatMap((x) => x.summary?.who || [])),
    direction: tally(live.map((x) => x.summary?.direction).filter(Boolean)),
  };
}

async function weeklyBriefing(list, ins, prev) {
  if (!GEMINI_KEY) return prev || null;
  if (prev?.date && (Date.parse(TODAY) - Date.parse(prev.date)) / 864e5 < 7) return prev;
  const since = addDays(TODAY, -7);
  const recent = list.filter((x) => (x.first_seen || '').slice(0, 10) >= since);
  if (!recent.length) return prev || null;
  const lines = recent.slice(0, 60).map((x) => {
    const s = x.summary || {};
    return `- [${x.stage.label}] ${x.title} | 분야:${(x.categories || []).join('/')} | 마감:${x.end || '-'} | 중요도:${s.importance || '-'} | ${s.oneline || ''}`;
  }).join('\n');
  const prompt =
`너는 에너지 정책 애널리스트야. 지난 7일간 새로 올라온 에너지 관련 입법·행정예고 목록을 보고 실무자용 주간 브리핑을 JSON으로만 써.
해석 원칙: 시행령·시행규칙·고시는 국회를 거치지 않아 수개월 안에 확정될 가능성이 높다. 국회 의원발의 법률안은 통과가 불확실하므로 '정치권 관심 신호'로 해석한다.
형식:
{"headline":"이번 주를 요약하는 한 문장",
 "trends":["눈에 띄는 흐름 2~4개. 여러 건이 같은 방향을 가리킬 때만 흐름이라고 쓸 것"],
 "soon":["곧 확정·시행될 가능성이 높은 변화 최대 3개(법령명 포함)"],
 "signals":["국회 법률안에서 읽히는 정치권 관심사 최대 3개"],
 "actions":["의견제출 마감 등 이번 주에 챙길 일 최대 3개"]}
목록에 없는 사실은 쓰지 마.${PROFILE ? `\n우리 관점(이 관점에서 중요도를 판단): ${PROFILE}` : ''}
여러 건이 몰린 법령: ${ins.hot.map((h) => `${h.law}(${h.count}건)`).join(', ') || '없음'}
분야별 최근 4주 건수(이전 8주를 4주로 환산한 값): ${ins.momentum.map((m) => `${m.cat} ${m.recent}(${m.before})`).join(', ')}
목록:
${lines}`;
  const b = await gemini(prompt);
  if (!b) return prev || null;
  console.log('  주간 브리핑 작성 완료');
  return { ...b, date: TODAY, count: recent.length };
}

// ---------- 실행 ----------
const old = new Map();
if (fs.existsSync(DATA)) {
  for (const x of JSON.parse(fs.readFileSync(DATA, 'utf8') || '[]')) old.set(x.id, x);
}

let fetched = [];
const ok = new Set();
for (const [name, fn] of [['국회', fetchAssembly], ['정부', fetchGov], ['행정규칙', fetchAdm], ['부처', fetchBoards]]) {
  try {
    const items = await fn();
    fetched = fetched.concat(items);
    if (items.length) ok.add(name);
  } catch (e) {
    console.log(`[${name}] 수집 실패 → 기존 데이터 유지: ${e.message}`);
  }
}

// 관보 게재로 정부·행정규칙 쪽에 이미 있는 부처 게시판 글은 제외
const govKeys = [...fetched, ...old.values()]
  .filter((x) => x.source === '정부' || x.source === '행정규칙').map((x) => normT(x.title));
const isDup = (t) => { const k = normT(t).slice(0, 12); return k.length >= 6 && govKeys.some((g) => g.includes(k)); };
for (const [id, v] of old) if (v.source === '부처' && isDup(v.title)) old.delete(id);
fetched = fetched.filter((x) => x.source !== '부처' || !isDup(x.title));
// 전력거래소는 수집하지 않음 → 이미 저장된 건 삭제
for (const [id, v] of old) if (v.proposer === '전력거래소') old.delete(id);
// 에너지와 무관한 주제(AI·정보통신 등) 제외 → keywords.json의 skip에서 관리
const SKIP = KW.skip || {};
const offTopic = (x) => {
  const t = x.title || '';
  return (SKIP.title || []).some((w) => t.includes(w)) && !(SKIP.unless || []).some((w) => t.includes(w));
};
fetched = fetched.filter((x) => !offTopic(x));
for (const [id, v] of old) if (offTopic(v)) { old.delete(id); console.log(`  제외(주제 무관): ${v.title}`); }

const current = new Set();
const newItems = [];
for (const it of fetched) {
  let cats = classify(`${it.title} ${it.field}`);
  if (it.cat) cats = [...new Set([...cats, it.cat])];
  if (!cats.length) continue;
  current.add(it.id);
  const prev = old.get(it.id);
  if (prev) {
    for (const [k, v] of Object.entries(it)) if (v && !(k === 'title' && /(\.\.\.|…)$/.test(v))) prev[k] = v;
    if (prev.body && prev.summary?.v !== 3) {          // 예전 요약 → 새 분석으로 보강
      const s = await summarize(prev);
      if (s) { prev.summary = s; console.log(`  분석 추가: ${prev.title}`); }
    }
    continue;
  }
  it.body = it.source === '국회' ? await fetchAssemblyBody(it)
    : it.source === '부처' ? await fetchBoardBody(it) : await fetchGovBody(it);
  cats = [...new Set([...cats, ...classify(it.body)])].sort();
  Object.assign(it, { categories: cats, summary: await summarize(it), first_seen: NOW });
  old.set(it.id, it);
  newItems.push(it);
  console.log(`  NEW [${it.source}] ${it.title} (${cats.join(', ')})`);
  await sleep(500);
}

for (const v of old.values()) {
  const end = toISO(v.end);
  if (end) v.status = end < TODAY ? '종료' : '진행';
  else if (ok.has(v.source)) v.status = current.has(v.id) ? '진행' : '종료';
  else v.status = v.status || '진행';
  v.stage = stageOf(v);
  v.law = lawOf(v.title);
}

fs.mkdirSync('docs/data', { recursive: true });
const list = [...old.values()].sort((a, b) => (b.first_seen || '').localeCompare(a.first_seen || ''));
fs.writeFileSync(DATA, JSON.stringify(list, null, 1));
fs.writeFileSync(META, JSON.stringify({ updated: NOW, sources: [...ok] }));
fs.writeFileSync(NEWF, JSON.stringify(newItems, null, 1));

const prevIns = fs.existsSync(INS) ? JSON.parse(fs.readFileSync(INS, 'utf8') || '{}') : {};
const ins = buildInsights(list);
ins.briefing = await weeklyBriefing(list, ins, prevIns.briefing);
ins.history = [ins.briefing, ...(prevIns.history || []).filter((b) => b && b.date !== ins.briefing?.date)]
  .filter(Boolean).slice(0, 12);
fs.writeFileSync(INS, JSON.stringify(ins, null, 1));
console.log(`신규 ${newItems.length}건 / 누적 ${old.size}건 / AI 분석 ${aiCalls}회`);
