// 에너지 입법·행정예고 수집기 + 인사이트 생성 (GitHub Actions에서 실행)
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileText } from './attach.mjs';

const KW = JSON.parse(fs.readFileSync('scripts/keywords.json', 'utf8'));
const BOARDS = fs.existsSync('scripts/boards.json') ? JSON.parse(fs.readFileSync('scripts/boards.json', 'utf8')) : [];
const PROFILE = fs.existsSync('scripts/profile.txt') ? fs.readFileSync('scripts/profile.txt', 'utf8').trim() : '';
const DATA = 'docs/data/bills.json';
const META = 'docs/data/meta.json';
const NEWF = 'docs/data/new.json';
const INS = 'docs/data/insights.json';
const FEED = 'docs/feed.xml';
const SITE = (process.env.SITE_URL || 'https://gemma-uxt.github.io/Energy-law-watch/').trim();
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ASSEMBLY_KEY = (process.env.ASSEMBLY_API_KEY || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
const AI_MAX = 40; // 한 번 실행에 분석할 최대 건수 (무료 한도 보호)
const GOV = 'https://opinion.lawmaking.go.kr';
const UA = { 'User-Agent': 'Mozilla/5.0 (energy-law-watch)', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
const NOW = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const TODAY = NOW.slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (iso, d) => new Date(Date.parse(iso) + d * 864e5).toISOString().slice(0, 10);

// ---------- 공통 도구 ----------
// as: 'text' | 'json' | 'buf'   opts: { method, body(form 문자열) }
async function get(url, as = 'text', opts = {}) {
  if (as === true) as = 'json';
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, {
        method: opts.method || 'GET',
        headers: {
          ...UA, ...(as === 'json' ? { Accept: 'application/json, text/plain, */*' } : {}),
          ...(opts.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: opts.body, signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return as === 'json' ? await r.json() : as === 'buf' ? Buffer.from(await r.arrayBuffer()) : await r.text();
    } catch (e) {
      console.log(`  ! 요청 실패(${i}/3): ${e.message}`);
      await sleep(5000 * i);
    }
  }
  throw new Error('요청 최종 실패: ' + url);
}

// 첨부파일(HWP·PDF)을 내려받아 글자로 변환
async function attachmentText(url, name = '', opts = {}) {
  try {
    const buf = await get(url, 'buf', opts);
    if (buf.length > 30e6) return '';
    const t = await fileText(buf, name);
    console.log(`    첨부 읽음: ${name || url} (${t.length}자)`);
    return t;
  } catch (e) {
    console.log(`    ! 첨부 읽기 실패: ${name || url} — ${e.message}`);
    return '';
  }
}
const BODY_MAX = 12000; // 저장·AI 분석에 쓰는 원문 최대 길이

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

// 분야 분류
// - 제목(+법제처 분야)에 나온 키워드로 1차 분류
// - 본문은 같은 분야 키워드가 여러 번(bodyMinHits) 나올 때만 반영 (한 번 스친 단어로 분야가 붙는 것 방지)
// - 영문 약어(ESS, REC 등)는 단어 단위·대소문자 구분으로만 찾음 (business, record 등 오탐 방지)
const CATS = Object.keys(KW.categories);
const kwRe = (k) => /^[A-Za-z]+$/.test(k)
  ? new RegExp(`(?<![A-Za-z])${k}(?![A-Za-z])`, 'g')
  : new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
const KW_RE = Object.fromEntries(Object.entries(KW.categories).map(([c, ks]) => [c, ks.map(kwRe)]));
const stripEx = (text) => { let t = text || ''; for (const ex of KW.exclude) t = t.split(ex).join(''); return t; };
function hits(text) {
  const t = stripEx(text);
  return Object.fromEntries(CATS.map((c) => [c, KW_RE[c].reduce((n, re) => n + (t.match(re) || []).length, 0)]));
}
function classify(text = '', minHits = 1) {
  const h = hits(text);
  return CATS.filter((c) => h[c] >= minHits);
}
// 한 건의 최종 분야 (매 실행마다 다시 계산 → 키워드를 고치면 과거 건에도 반영됨)
function categorize(x) {
  let cats = classify(x.title);
  if (!cats.length && /전기ㆍ가스|전기·가스/.test(x.field || '')) {
    cats = [/가스|석유|LPG|광업/.test(x.title) ? '가스·석유·자원' : '전기·전력'];
  }
  if (x.cat) cats.push(x.cat);
  const ai = (x.summary?.categories || []).filter((c) => CATS.includes(c));
  if (ai.length) cats.push(...ai);
  else if (x.body) cats.push(...classify(x.body, KW.bodyMinHits || 3).filter((c) => c !== KW.fallback));
  if (!cats.length && /에너지/.test(stripEx(`${x.title} ${x.body || ''}`))) cats.push(KW.fallback);
  return [...new Set(cats)].sort((a, b) => CATS.indexOf(a) - CATS.indexOf(b));
}
const relevant = (x) => classify(`${x.title} ${x.field}`).length > 0 || !!x.cat
  || /에너지|전기ㆍ가스|전기·가스/.test(stripEx(`${x.title} ${x.field}`));

// ---------- 단계(법이 되기까지의 거리)와 기준 법령 ----------
const ST = {
  done: { order: 0, key: 'done', label: '확정·시행', speed: '이미 확정', note: '규칙개정위원회·전기위원회 심의와 장관 승인을 거쳐 공고·시행된 전력시장 규칙' },
  rule: { order: 1, key: 'rule', label: '전력시장 규칙 심의', speed: '매우 빠름(보통 1~2개월)', note: '규칙개정위원회 → 전기위원회 심의 → 장관 승인 → 공고·시행. 국회·법제처를 거치지 않음' },
  adm: { order: 2, key: 'adm', label: '고시·훈령 등', speed: '가장 빠름(수주~수개월)', note: '국회를 거치지 않고 부처가 확정해 발령하는 행정규칙' },
  low: { order: 3, key: 'low', label: '시행령·시행규칙', speed: '빠름(보통 수개월)', note: '국회 의결 없이 규제·법제처 심사와 국무회의(부령은 장관 발령)로 확정' },
  law: { order: 4, key: 'law', label: '정부 법률안', speed: '중기(국회 심사 필요)', note: '입법예고 뒤 국무회의를 거쳐 국회에 제출되며, 국회 통과가 남아 있음' },
  na: { order: 5, key: 'na', label: '국회 법률안', speed: '장기·불확실', note: '상임위·법사위·본회의를 모두 통과해야 하며, 상당수는 대안에 흡수되거나 임기만료로 폐기됨' },
};
function stageOf(x) {
  const t = x.title || '';
  // 정부 법률안 제목은 '일부개정법률(안)'처럼 괄호가 붙는 경우가 많음
  const isLaw = /법률\s*(\(안\)|안)|법\s*(일부|전부)?\s*개정\s*(\(안\)|안)|법\s*제정\s*(\(안\)|안)/.test(t)
    && !/시행령|시행규칙|개정령|제정령|고시|규정|지침|훈령|예규/.test(t);
  if (x.source === '국회') return ST.na;
  if (x.source === '전력시장') return ST[x.stageKey] || ST.rule;
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

// 국회 입법예고 페이지에서 '제안이유 및 주요내용' 추출
// (예전 방식은 본문이 4,000자를 넘으면 통째로 실패 → 긴 법안은 요약이 비어 있었음)
async function fetchAssemblyBody(item) {
  const urls = [item.link || (item.bill_id && `https://pal.assembly.go.kr/napal/lgsltpa/lgsltpaOngoing/view.do?lgsltPaId=${item.bill_id}`)];
  for (const u of urls.filter(Boolean)) {
    try {
      const t = htmlToText(await get(u));
      const i = t.search(/제안이유/);
      if (i < 0) continue;
      let s = t.slice(i, i + BODY_MAX);
      const stop = s.slice(30).search(/의견제출 방법|입법예고 목록보기|목록보기|의견등록\n|개인정보처리방침/);
      if (stop > 0) s = s.slice(0, stop + 30);
      if (s.length > 80) return s.trim();
    } catch {}
  }
  return '';
}

// 국회 법률안 심사 진행 단계 (의안정보시스템)
async function fetchBillProgress(item) {
  if (!item.bill_id) return null;
  const L = 'https://likms.assembly.go.kr/bill/bi';
  const body = `billId=${encodeURIComponent(item.bill_id)}`;
  const d = (await get(`${L}/common/findBillDetail.do`, 'json', { method: 'POST', body }))?.data || {};
  const html = await get(`${L}/bill/detail/billInfo.do`, 'text', { method: 'POST', body });
  const cell = (cls) => clean((html.match(new RegExp(`class="${cls}"[\\s\\S]*?<span>([\\s\\S]*?)</span>`)) || [])[1] || '');
  const cmt = { submit: cell('submitDt'), present: cell('presentDt'), proc: cell('procDt'), result: cell('inscResultCd') };
  const md = (s) => (s || '').slice(5).replace('-', '/');
  let step = 1, label = `접수(${md(d.proposeDt)})`;
  if (cmt.submit) { step = 2; label = `소관위 회부(${md(cmt.submit)})`; }
  if (cmt.present) { step = 2; label = `소관위 상정(${md(cmt.present)})`; }
  if (cmt.proc) { step = 3; label = `소관위 ${cmt.result || '처리'}(${md(cmt.proc)}) → 법사위`; }
  if (d.procResultName) { step = 4; label = `본회의 ${d.procResultName}${d.procDt ? `(${md(d.procDt)})` : ''}`; }
  if (d.govTransDt) { step = 5; label = `정부이송(${md(d.govTransDt)})`; }
  if (d.announceDt) { step = 6; label = `공포(${md(d.announceDt)})`; }
  const dead = /폐기|부결|철회|대안반영/.test(`${d.procResultName || ''} ${cmt.result}`);
  return { step, label, dead, checked: TODAY };
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
    return reasonPart(t);
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
            id: (b.source === '전력시장' ? 'KPX-' : 'MIN-') + createHash('md5').update(link).digest('hex').slice(0, 12),
            source: b.source || '부처', title, proposer: b.name, org: b.kind || '행정예고(부처 게시판)',
            field: b.cat || '', start: posted, end, posted, link,
            cat: b.cat || '', noDeadline: !!b.noDeadline,
            ...(b.stage ? { stageKey: b.stage } : {}),
            ...(b.attach ? { attach: true, attachPrefer: b.attachPrefer || '' } : {}),
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

// 게시글 HTML에서 첨부파일(HWP·HWPX·PDF) 링크 찾기
function findAttachments(html, pageUrl) {
  const out = [];
  const seen = new Set();
  const blocks = html.match(/<li\b[\s\S]*?<\/li>/gi) || [];
  const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  for (const src of [...blocks, ...anchors]) {
    const a = (src.match(/<a\b[^>]*href="([^"]*(?:[Dd]own|[Ff]ile|atch)[^"]*)"/) || [])[1];
    if (!a || /^javascript/i.test(a)) continue;
    const name = (clean(src).match(/[^\s][^<>\n]*?\.(hwpx?|pdf)\b/i) || [])[0] || '';
    if (!name) continue;
    const url = new URL(decode(a), pageUrl).href;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, name: name.trim() });
  }
  return out;
}

async function readAttachments(item, html) {
  const files = findAttachments(html, item.link);
  if (!files.length) return '';
  const pref = item.attachPrefer ? new RegExp(item.attachPrefer) : null;
  files.sort((a, b) => (pref ? +pref.test(b.name) - +pref.test(a.name) : 0));
  let text = '';
  for (const f of files.slice(0, 2)) {
    const t = await attachmentText(f.url, f.name);
    if (t) text += `\n[첨부: ${f.name}]\n${t}\n`;
    if (text.length > BODY_MAX) break;
  }
  return text.slice(0, BODY_MAX);
}

// '제정·개정 이유 / 주요내용'부터 '의견제출' 앞까지 잘라내기
// (예전 정규식은 4,000~5,000자 안에 끝 표시가 없으면 통째로 실패했음)
function reasonPart(t) {
  const i = t.search(/(제정|개정|폐지)\s*(이유|사유)|주요\s*내용/);
  if (i < 0) return '';
  let s = t.slice(i, i + BODY_MAX);
  const stop = s.slice(30).search(/의견\s*제출/);
  if (stop > 0) s = s.slice(0, stop + 30);
  return s.trim();
}

async function fetchBoardBody(item) {
  try {
    const html = await get(item.link);
    const t = htmlToText(html);
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
    if (item.attach) {                       // 본문은 짧고 내용은 첨부(HWP·PDF)에 있는 게시판
      const main = clean((html.match(/<div class="contents">([\s\S]*?)<\/div>/i) || [])[1] || '');
      const att = await readAttachments(item, html);
      const body = `${main}\n${att}`.trim();
      if (body.length > 50) return body.slice(0, BODY_MAX);
    }
    const r = reasonPart(t);
    if (r) return r;
    for (const key of ['행정절차법', '알려드리오니', '회의결과']) {
      const i = t.indexOf(key);
      if (i >= 0) {
        const s = t.slice(Math.max(0, i - 300), i + 2500).trim();
        // 게시글 본문이 짧으면 첨부파일(HWP·PDF)에서 보충
        return s.length < 600 ? `${s}\n${await readAttachments(item, html)}`.trim().slice(0, BODY_MAX) : s;
      }
    }
    return (await readAttachments(item, html)).trim();
  } catch { return ''; }
}

// ---------- 전기위원회: 위원회 개최결과 (PDF 첨부) ----------
async function fetchKorec(days = 90) {
  const base = 'https://www.korec.go.kr';
  const listUrl = `${base}/notice/result/selectNoticeList.do`;
  let html = await get(listUrl);
  if (!/bbsSntncNo/.test(html)) html = await get(listUrl, 'text', { method: 'POST', body: 'dep0=1&dep1=1&dep2=0' });
  const out = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const no = (tr.match(/name="bbsSntncNo"\s+value="(\d+)"/) || [])[1];
    if (!no) continue;
    const title = decode((tr.match(/<a[^>]*title="([^"]+)"/) || [])[1] || clean(tr)).trim();
    const posted = toISO((tr.match(/등록일">\s*([\d-]+)/) || [])[1] || clean(tr));
    if (posted && (Date.parse(TODAY) - Date.parse(posted)) / 864e5 > days) continue;
    const files = [...tr.matchAll(/name="fileName"\s+value="([^"]+)"/g)].map((m) => decode(m[1]));
    const path = decode((tr.match(/name="filePath"\s+value="([^"]+)"/) || [])[1] || '/notice');
    out.push({
      id: `KOREC-${no}`, source: '전력시장', title, proposer: '전기위원회', org: '위원회 개최결과',
      field: '전기·전력', start: posted, end: '', posted, link: listUrl,
      cat: '전기·전력', noDeadline: true, stageKey: 'rule', files, filePath: path,
    });
  }
  console.log(`[전력시장] 전기위원회 개최결과 ${out.length}건`);
  return out;
}

async function fetchKorecBody(item) {
  let text = '';
  for (const f of (item.files || []).slice(0, 2)) {
    const body = `attachingFilePath=${encodeURIComponent(item.filePath || '/notice')}&attachingFileNm=${encodeURIComponent(f)}`;
    const t = await attachmentText('https://www.korec.go.kr/commonfile/fileDownLoad.do', f, { method: 'POST', body });
    if (t) text += t + '\n';
  }
  return text.slice(0, BODY_MAX).trim();
}

async function fetchMarket() {
  // 전력거래소 게시판은 boards.json(source: 전력시장)에서 함께 수집
  return fetchKorec();
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

const WHO = ['발전사', '원전 운영사', '전력판매·한전', '집단에너지사업자', '재생에너지사업자', '가스·석유사업자',
  '수소사업자', '전력다소비 기업', '일반소비자', '지자체', '정부·공공기관', '기타'];
const WHO_FIX = { '원자력': '원전 운영사' };   // 예전 분석 결과의 이름 정리
const PERMIT_KINDS = ['허가', '조건부 허가', '변경허가', '양수인가', '기간 연장', '허가취소', '허가반납', '심의보류'];
const DIR = ['규제강화', '규제완화', '지원·인센티브', '시장제도 변경', '절차·행정', '기타'];
let aiCalls = 0;
async function summarize(item) {
  if (!GEMINI_KEY || !item.body || item.body.length < 150 || aiCalls >= AI_MAX) return null;
  aiCalls++;
  const st = stageOf(item);
  const KOREC = item.id.startsWith('KOREC-');
  const prompt =
`너는 에너지 분야 법률·정책 분석가야. 아래 원문을 읽고 JSON으로만 답해.
이 문서의 단계: ${st.label} (${st.note})
형식:
{"oneline":"핵심 한 문장(60자 이내)",
 "reason":"개정(제정) 이유 2~3문장",
 "points":["주요 내용, 각 50자 이내, 최대 ${item.source === '전력시장' ? 10 : 5}개"],
 "impact":"영향과 실무 시사점 1~2문장",
 "categories":["이 문서의 분야. 다음 중에서만, 실제로 핵심인 것만 1~3개: ${CATS.join(', ')}"],
 "who":["영향받는 주체. 다음 중에서만 고를 것: ${WHO.join(', ')}"],
 "direction":"다음 중 하나: ${DIR.join(', ')}",
 "watch":"실무자가 지금 확인하거나 준비할 점 1문장"${KOREC ? `,
 "permits":[{"name":"발전소·사업 이름(원문 그대로, 예: 포항 동백이풍력 발전사업)","kind":"${PERMIT_KINDS.join(' / ')} 중 하나","cond":"조건·사유(없으면 빈 값)"}]` : ''}${PROFILE ? `,
 "fit":"아래 '우리 관점'에서 본 영향 1문장 (관련이 적으면 '직접 관련 낮음')"` : ''}}
원문에 없는 내용은 지어내지 말고, 알 수 없으면 빈 값으로 둬.${KOREC ? `
이 문서는 전기위원회 개최 결과야. 독자가 가장 알고 싶은 것은 '어떤 발전소가 허가·인가·취소를 받았는지'야.
- permits에는 원문에 나온 발전사업 허가·조건부 허가·변경허가·양수인가·준비기간/공사계획인가기간 연장·허가취소·허가반납·심의보류 대상을 하나도 빠짐없이 발전소 이름 그대로 모두 적을 것. "다수", "등", "총 N건" 같은 뭉뚱그린 표현 금지.
- 원문은 PDF에서 뽑아 글자 순서가 일부 뒤섞여 있을 수 있으니 문맥으로 바로잡을 것.
- points에는 허가 외의 안건(규칙·규정 개정, 요금·약관 인가 등)을 안건명이 드러나게 구체적으로 적을 것.` : ''}
categories 판단 기준: 본문에 한 번 언급된 정도가 아니라 이 문서가 실제로 바꾸는 대상의 분야만 고를 것. 예) 전기공사업·발전소 주변지역·전력망은 '전기·전력'이지 '가스·석유·자원'이 아님. '에너지 일반·효율'은 다른 분야에 딱 맞지 않을 때만.
who 판단 기준: 원자력발전소를 운영하는 사업자(한수원 등)는 '원전 운영사'.
direction 판단 기준: 규제받는 대상(사업자·기관·국민)의 의무·제한이 늘거나 엄격해지면 '규제강화', 줄거나 느슨해지면 '규제완화'. 온도·수치 기준은 대상이 더 자유롭게 행동할 수 있게 바뀌면 완화(예: 냉방 28℃→26℃, 난방 18℃→20℃는 완화). 강화와 완화가 섞이면 비중이 큰 쪽을 고를 것.${PROFILE ? `\n\n우리 관점: ${PROFILE}` : ''}

제목: ${item.title}
원문:
${item.body.slice(0, BODY_MAX)}`;
  const s = await gemini(prompt);
  if (s) {
    s.v = 4;
    delete s.importance; delete s.importance_reason;
    if (!Array.isArray(s.who)) s.who = [];
    if (!Array.isArray(s.points)) s.points = s.points ? [String(s.points)] : [];
    s.categories = (Array.isArray(s.categories) ? s.categories : []).filter((c) => CATS.includes(c));
    if (KOREC) s.permits = (Array.isArray(s.permits) ? s.permits : []).filter((p) => p && p.name);
  }
  return s;
}

// ---------- 인사이트 집계 ----------
function buildInsights(list) {
  const dateOf = (x) => toISO(x.start) || (x.first_seen || '').slice(0, 10);
  // 수집을 시작한 날: 이 날 이전 주는 '그때 진행 중이던 건'만 잡혀 있어 실제보다 적게 보임
  const since = list.reduce((m, x) => (x.first_seen && x.first_seen.slice(0, 10) < m ? x.first_seen.slice(0, 10) : m), TODAY);
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const from = addDays(TODAY, -7 * i - 6), to = addDays(TODAY, -7 * i);
    weeks.push({ from, to, total: 0, cats: {}, partial: from < since });
  }
  for (const x of list) {
    const d = dateOf(x);
    const w = weeks.find((w) => d >= w.from && d <= w.to);
    if (!w) continue;
    w.total++;
    for (const c of x.categories || []) w.cats[c] = (w.cats[c] || 0) + 1;
  }
  // 증감 비교(최근 4주 vs 그 이전 8주)는 수집 기간이 12주를 넘어야 의미가 있음
  const momentumFrom = addDays(since, 84);
  const momentumReady = TODAY >= momentumFrom;
  const momentum = CATS.map((c) => {
    const recent = weeks.slice(-4).reduce((a, w) => a + (w.cats[c] || 0), 0);
    const before = weeks.slice(0, 8).reduce((a, w) => a + (w.cats[c] || 0), 0) / 2;
    return { cat: c, recent, before: Math.round(before * 10) / 10 };
  }).filter((m) => m.recent || m.before);

  const from6m = addDays(TODAY, -180);
  const groups = {};
  for (const x of list) {
    if (!x.law || x.law.length < 3 || dateOf(x) < from6m || x.source === '전력시장') continue;
    (groups[x.law] ||= []).push(x);
  }
  const hot = Object.entries(groups).filter(([, a]) => a.length >= 2)
    .map(([law, a]) => ({
      law, count: a.length,
      stages: [...new Set(a.sort((p, q) => q.stage.order - p.stage.order).map((x) => x.stage.label))],
      items: a.slice(0, 6).map((x) => ({
        title: x.title, source: x.source, status: x.status, link: x.link,
        proposer: x.proposer || '', date: dateOf(x), oneline: x.summary?.oneline || '',
      })),
    }))
    .sort((a, b) => b.count - a.count).slice(0, 10);

  const live = list.filter((x) => x.status === '진행');
  const stages = {};
  for (const x of live) (stages[x.stage.label] ||= { ...x.stage, n: 0 }).n++;
  const tally = (arr) => Object.entries(arr.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1]);
  return {
    updated: NOW, since, weeks, momentum, momentumReady, momentumFrom, hot,
    stages: Object.values(stages).sort((a, b) => a.order - b.order),
    who: tally(live.flatMap((x) => x.summary?.who || [])),
    direction: tally(live.map((x) => x.summary?.direction).filter(Boolean)),
  };
}

async function weeklyBriefing(list, ins, prev) {
  if (!GEMINI_KEY || OFFLINE) return prev || null;
  if (prev?.date && (Date.parse(TODAY) - Date.parse(prev.date)) / 864e5 < 7) return prev;
  const since = addDays(TODAY, -7);
  const recent = list.filter((x) => (x.first_seen || '').slice(0, 10) >= since);
  if (!recent.length) return prev || null;
  const lines = recent.slice(0, 60).map((x) => {
    const s = x.summary || {};
    return `- [${x.stage.label}] ${x.title} | 분야:${(x.categories || []).join('/')} | 마감:${x.end || '-'} | ${s.oneline || ''}`;
  }).join('\n');
  const prompt =
`너는 에너지 정책 애널리스트야. 지난 7일간 새로 올라온 에너지 관련 입법·행정예고와 전력시장 규칙 개정 목록을 보고 실무자용 주간 브리핑을 JSON으로만 써.
해석 원칙: 전력시장 규칙과 시행령·시행규칙·고시는 국회를 거치지 않아 빠르게 확정될 가능성이 높다. 국회 의원발의 법률안은 통과가 불확실하므로 '정치권 관심 신호'로 해석한다.
형식:
{"headline":"이번 주를 요약하는 한 문장",
 "trends":["눈에 띄는 흐름 2~4개. 여러 건이 같은 방향을 가리킬 때만 흐름이라고 쓸 것"],
 "soon":["곧 확정·시행될 가능성이 높은 변화 최대 3개(법령명 포함)"],
 "signals":["국회 법률안에서 읽히는 정치권 관심사 최대 3개"],
 "actions":["의견제출 마감 등 이번 주에 챙길 일 최대 3개"]}
목록에 없는 사실은 쓰지 마.${PROFILE ? `\n우리 관점: ${PROFILE}` : ''}
여러 건이 몰린 법령: ${ins.hot.map((h) => `${h.law}(${h.count}건)`).join(', ') || '없음'}
목록:
${lines}`;
  const b = await gemini(prompt);
  if (!b) return prev || null;
  console.log('  주간 브리핑 작성 완료');
  return { ...b, date: TODAY, count: recent.length };
}

// ---------- 알림: RSS 피드 + (선택) 텔레그램 ----------
const xmlEsc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
function writeFeed(list) {
  const items = list.slice(0, 40).map((x) => {
    const d = new Date((x.first_seen || NOW).replace(' ', 'T') + ':00+09:00').toUTCString();
    const desc = [x.stage?.label, x.proposer, x.end ? `의견마감 ${toISO(x.end)}` : '', x.summary?.oneline].filter(Boolean).join(' · ');
    return `<item><title>${xmlEsc(`[${x.source}] ${x.title}`)}</title><link>${xmlEsc(x.link || SITE)}</link>` +
      `<guid isPermaLink="false">${xmlEsc(x.id)}</guid><pubDate>${d}</pubDate><description>${xmlEsc(desc)}</description>` +
      (x.categories || []).map((c) => `<category>${xmlEsc(c)}</category>`).join('') + '</item>';
  }).join('\n');
  fs.writeFileSync(FEED, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>에너지 입법예고 워치</title><link>${xmlEsc(SITE)}</link>
<description>에너지 관련 입법·행정예고와 전력시장 규칙 개정 새 소식</description><language>ko</language>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</channel></rss>
`);
}

async function telegram(newItems, list) {
  if (!TG_TOKEN || !TG_CHAT || OFFLINE) return;
  const dd = (x) => { const e = toISO(x.end); return e ? Math.round((Date.parse(e) - Date.parse(TODAY)) / 864e5) : null; };
  const lines = [];
  if (newItems.length) {
    lines.push(`🆕 새로 올라온 ${newItems.length}건`);
    for (const x of newItems.slice(0, 15)) lines.push(`• [${x.stage?.label || x.source}] ${x.title}${x.summary?.oneline ? `\n   └ ${x.summary.oneline}` : ''}`);
  }
  // 마감 3일 전 알림은 아침 실행(07시대)에서만 1번
  if (Number(NOW.slice(11, 13)) < 10) {
    const due = list.filter((x) => x.status === '진행' && [0, 1, 2, 3].includes(dd(x)));
    if (due.length) {
      lines.push(`\n⏰ 의견마감 임박 ${due.length}건`);
      for (const x of due.slice(0, 15)) lines.push(`• D-${dd(x) || 'DAY'} ${x.title}`);
    }
  }
  if (!lines.length) return;
  lines.push(`\n${SITE}`);
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: lines.join('\n').slice(0, 4000), disable_web_page_preview: true }),
    });
    console.log(`  텔레그램 알림 ${r.ok ? '보냄' : '실패 ' + r.status}`);
  } catch (e) { console.log('  ! 텔레그램 알림 실패: ' + e.message); }
}

// ---------- 저장 직전 정리 (매 실행마다 전체 건에 적용) ----------
function finalize(v) {
  if (v.source === '전력시장' && !v.stageKey) v.stageKey = v.id.startsWith('KOREC-') ? 'rule' : /공고|시행\)/.test(v.title) ? 'done' : 'rule';
  const end = toISO(v.end);
  if (v.noDeadline || v.source === '전력시장') {
    const p = toISO(v.posted || v.start) || (v.first_seen || '').slice(0, 10);
    v.status = p && (Date.parse(TODAY) - Date.parse(p)) / 864e5 > 60 ? '종료' : '진행';
  } else if (end) v.status = end < TODAY ? '종료' : '진행';
  else if (ok.has(v.source)) v.status = current.has(v.id) ? '진행' : '종료';
  else v.status = v.status || '진행';
  if (v.summary && typeof v.summary === 'object') {
    delete v.summary.importance; delete v.summary.importance_reason;
    if (Array.isArray(v.summary.who)) v.summary.who = [...new Set(v.summary.who.map((w) => WHO_FIX[w] || w))];
  }
  v.categories = categorize(v);
  v.stage = stageOf(v);
  v.law = lawOf(v.title);
}

// ---------- 실행 ----------
// node scripts/collect.mjs --offline  → 새로 수집하지 않고 저장된 데이터만 다시 분류·집계
const OFFLINE = process.argv.includes('--offline');
const old = new Map();
if (fs.existsSync(DATA)) {
  for (const x of JSON.parse(fs.readFileSync(DATA, 'utf8') || '[]')) old.set(x.id, x);
}

let fetched = [];
const ok = new Set();
const FETCHERS = [['국회', fetchAssembly], ['정부', fetchGov], ['행정규칙', fetchAdm], ['부처', fetchBoards], ['전력시장', fetchMarket]];
for (const [name, fn] of OFFLINE ? [] : FETCHERS) {
  try {
    const items = await fn();
    fetched = fetched.concat(items);
    if (items.length) { ok.add(name); for (const x of items) ok.add(x.source); }
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
// 같은 수집처 안에서 제목이 같은 중복 글 제거 (게시판 링크만 다른 경우)
const seenTitle = new Set([...old.values()].filter((x) => x.source !== '국회' && x.source !== '정부')
  .map((x) => `${x.source}|${normT(x.title)}`));
fetched = fetched.filter((x) => {
  if (old.has(x.id) || x.source === '국회' || x.source === '정부') return true;  // 국회·정부는 같은 제목의 다른 안이 흔함
  const k = `${x.source}|${normT(x.title)}`;
  if (seenTitle.has(k)) return false;
  seenTitle.add(k);
  return true;
});
// 에너지와 무관한 주제(AI·정보통신 등) 제외 → keywords.json의 skip에서 관리
const SKIP = KW.skip || {};
const offTopic = (x) => {
  const t = x.title || '';
  if ((SKIP.drop || []).some((w) => t.includes(w))) return true;   // 무조건 제외(수수료·가스시설 안전·광물 등)
  return (SKIP.title || []).some((w) => t.includes(w)) && !(SKIP.unless || []).some((w) => t.includes(w));
};
fetched = fetched.filter((x) => !offTopic(x));
for (const [id, v] of old) if (offTopic(v)) { old.delete(id); console.log(`  제외(주제 무관): ${v.title}`); }

const bodyOf = (it) => it.source === '국회' ? fetchAssemblyBody(it)
  : it.id.startsWith('KOREC-') ? fetchKorecBody(it)
  : (it.source === '부처' || it.source === '전력시장') ? fetchBoardBody(it) : fetchGovBody(it);

const current = new Set();
const newItems = [];
let retries = 0;
for (const it of fetched) {
  if (!relevant(it)) continue;
  current.add(it.id);
  const prev = old.get(it.id);
  if (prev) {
    for (const [k, v] of Object.entries(it)) if (v && !(k === 'title' && /(\.\.\.|…)$/.test(v))) prev[k] = v;
    // 예전에 본문을 못 읽은 건은 다시 시도 (첨부파일 읽기 추가·추출 방식 개선분 반영)
    if ((!prev.body || prev.body.length < 150) && retries < 10) {
      retries++;
      const b = await bodyOf(prev);
      if (b && b.length > (prev.body || '').length) { prev.body = b; prev.summary = null; console.log(`  본문 보강: ${prev.title}`); }
    }
    const needPermits = prev.id.startsWith('KOREC-') && !Array.isArray(prev.summary?.permits);
    if (needPermits) { const b = await bodyOf(prev); if (b) prev.body = b; }   // 반복 글자 정리된 원문으로 다시 읽기
    if (prev.body && (!prev.summary || (prev.summary.v || 0) < 4 || needPermits)) {   // 요약 없음·예전 요약 → 새 분석
      const s = await summarize(prev);
      if (s) { prev.summary = s; console.log(`  분석 추가: ${prev.title}`); }
    }
    continue;
  }
  it.body = await bodyOf(it);
  Object.assign(it, { summary: await summarize(it), first_seen: NOW });
  old.set(it.id, it);
  newItems.push(it);
  console.log(`  NEW [${it.source}] ${it.title}`);
  await sleep(500);
}

// 국회 법률안 심사 진행 단계 갱신 (하루 1번)
let prog = 0;
for (const v of OFFLINE ? [] : old.values()) {
  if (v.source !== '국회' || v.progress?.checked === TODAY || v.progress?.step >= 6 || v.progress?.dead || prog >= 60) continue;
  prog++;
  try { const p = await fetchBillProgress(v); if (p) v.progress = p; } catch (e) { console.log(`  ! 심사단계 조회 실패: ${v.title}`); }
  await sleep(300);
}

for (const v of old.values()) finalize(v);

fs.mkdirSync('docs/data', { recursive: true });
const list = [...old.values()].sort((a, b) => (b.first_seen || '').localeCompare(a.first_seen || ''));
fs.writeFileSync(DATA, JSON.stringify(list, null, 1));
const prevMeta = fs.existsSync(META) ? JSON.parse(fs.readFileSync(META, 'utf8') || '{}') : {};
fs.writeFileSync(META, JSON.stringify(OFFLINE ? prevMeta : { updated: NOW, sources: [...ok] }));
if (!OFFLINE) fs.writeFileSync(NEWF, JSON.stringify(newItems, null, 1));
writeFeed(list);

const prevIns = fs.existsSync(INS) ? JSON.parse(fs.readFileSync(INS, 'utf8') || '{}') : {};
const ins = buildInsights(list);
ins.briefing = await weeklyBriefing(list, ins, prevIns.briefing);
ins.history = [ins.briefing, ...(prevIns.history || []).filter((b) => b && b.date !== ins.briefing?.date)]
  .filter(Boolean).slice(0, 12);
fs.writeFileSync(INS, JSON.stringify(ins, null, 1));
await telegram(newItems.map((x) => list.find((y) => y.id === x.id) || x), list);
console.log(`신규 ${newItems.length}건 / 누적 ${old.size}건 / AI 분석 ${aiCalls}회`);
