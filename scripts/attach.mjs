// 첨부파일(HWP·HWPX·PDF)에서 본문 글자를 뽑아내는 도구
// - HWP(한글 5.x): 별도 프로그램 없이 직접 해석
// - HWPX: zip 안의 XML에서 글자만 추출
// - PDF: pdfjs-dist 사용 (워크플로에서 설치)
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------- HWP 5.x (OLE 복합문서) ----------
function readCFB(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  if (u32(0) !== 0xE011CFD0 || u32(4) !== 0xE11AB1A1) throw new Error('HWP(OLE) 형식 아님');
  const secSize = 1 << u16(0x1E);
  const miniSize = 1 << u16(0x20);
  const nFat = u32(0x2C);
  const dirStart = u32(0x30);
  const cutoff = u32(0x38);
  const miniFatStart = u32(0x3C);
  let difatSec = u32(0x44);
  const secOff = (s) => 512 + s * secSize;

  const fatSecs = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) fatSecs.push(u32(0x4C + i * 4));
  while (fatSecs.length < nFat && difatSec < 0xFFFFFFFA) {
    const o = secOff(difatSec);
    for (let i = 0; i < secSize / 4 - 1 && fatSecs.length < nFat; i++) fatSecs.push(u32(o + i * 4));
    difatSec = u32(o + secSize - 4);
  }
  const fat = [];
  for (const s of fatSecs) { const o = secOff(s); for (let i = 0; i < secSize / 4; i++) fat.push(u32(o + i * 4)); }
  const chain = (start, table) => {
    const out = [];
    for (let s = start, n = 0; s < 0xFFFFFFFA && n < 1e6; s = table[s], n++) out.push(s);
    return out;
  };
  const readBig = (start, size) => {
    const parts = chain(start, fat).map((s) => buf.subarray(secOff(s), secOff(s) + secSize));
    return Buffer.concat(parts).subarray(0, size);
  };

  const dirBuf = readBig(dirStart, 1e9);
  const entries = [];
  for (let o = 0; o + 128 <= dirBuf.length; o += 128) {
    const e = dirBuf.subarray(o, o + 128);
    const ev = new DataView(e.buffer, e.byteOffset, 128);
    const nameLen = ev.getUint16(0x40, true);
    entries.push({
      name: e.subarray(0, Math.max(0, nameLen - 2)).toString('utf16le'),
      type: e[0x42], left: ev.getUint32(0x44, true), right: ev.getUint32(0x48, true),
      child: ev.getUint32(0x4C, true), start: ev.getUint32(0x74, true), size: ev.getUint32(0x78, true),
    });
  }
  const root = entries[0];
  const miniFat = [];
  if (miniFatStart < 0xFFFFFFFA) {
    const mf = readBig(miniFatStart, 1e9);
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mf.readUInt32LE(i));
  }
  const miniStream = root.start < 0xFFFFFFFA ? readBig(root.start, root.size) : Buffer.alloc(0);
  const readStream = (e) => {
    if (e.size < cutoff) {
      return Buffer.concat(chain(e.start, miniFat).map((s) => miniStream.subarray(s * miniSize, (s + 1) * miniSize))).subarray(0, e.size);
    }
    return readBig(e.start, e.size);
  };
  const children = (idx) => {
    const out = [];
    const walk = (i, d) => {
      if (i >= entries.length || i === 0xFFFFFFFF || d > 500) return;
      const e = entries[i];
      walk(e.left, d + 1); out.push(e); walk(e.right, d + 1);
    };
    walk(entries[idx].child, 0);
    return out;
  };
  return { entries, children, readStream };
}

function paraText(rec) {
  let s = '';
  for (let i = 0; i + 1 < rec.length;) {
    const c = rec.readUInt16LE(i);
    if (c >= 32) { s += String.fromCharCode(c); i += 2; continue; }
    if (c === 13 || c === 10) s += '\n';
    else if (c === 9) s += '\t';
    else if (c === 24 || c === 30 || c === 31) s += ' ';
    // 1글자짜리 제어문자: 0,10,13,24~31 / 그 외(1~9,11~23)는 8글자(16바이트) 크기
    i += ([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31].includes(c)) ? 2 : 16;
  }
  return s;
}

// 배포용 문서(복사·인쇄 제한 문서) 본문 복호화
// 각 Section 스트림 앞 260바이트(레코드 헤더 4 + 배포용 문서 데이터 256)에서 AES-128 키를 꺼낸 뒤
// 나머지를 AES-128-ECB로 풀고, 압축돼 있으면 압축을 해제함 (한글 문서 형식 5.0 공개 문서 기준)
function distKey(d) {
  const seed = d.readUInt32LE(0);
  let st = seed >>> 0;
  const rand = () => { st = (Math.imul(st, 214013) + 2531011) >>> 0; return (st >>> 16) & 0x7FFF; };
  const out = Buffer.alloc(256);
  let n = 0, k = 0;
  for (let i = 0; i < 256; i++) {
    if (n === 0) { k = rand() & 0xFF; n = (rand() & 0xF) + 1; }
    out[i] = d[i] ^ k; n--;
  }
  const off = 4 + (seed & 0xF);
  return out.subarray(off, off + 16);
}
export function decodeDistSection(raw) {
  const tag = raw.readUInt32LE(0) & 0x3FF;
  if (tag !== 28) throw new Error('배포용 문서 데이터 없음');
  const key = distKey(raw.subarray(4, 260));
  const enc = raw.subarray(260, 260 + Math.floor((raw.length - 260) / 16) * 16);
  const dec = crypto.createDecipheriv('aes-128-ecb', key, null);
  dec.setAutoPadding(false);
  return Buffer.concat([dec.update(enc), dec.final()]);
}
const inflate = (b) => zlib.inflateRawSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH });

// 압축 해제된 Section 스트림에서 문단 글자(HWPTAG_PARA_TEXT=67)만 모으기
export function sectionText(data) {
  let out = '';
  for (let o = 0; o + 4 <= data.length;) {
    const h = data.readUInt32LE(o); o += 4;
    const tag = h & 0x3FF;
    let size = h >>> 20;
    if (size === 0xFFF) { size = data.readUInt32LE(o); o += 4; }
    if (tag === 67) out += paraText(data.subarray(o, o + size));
    o += size;
  }
  return out;
}

export function hwpText(buf) {
  const cfb = readCFB(buf);
  const idx = (name, parent = 0) => cfb.children(parent).find((e) => e.name === name);
  const header = idx('FileHeader');
  if (!header) throw new Error('FileHeader 없음');
  const flags = cfb.readStream(header).readUInt32LE(36);
  if (flags & 0x2) throw new Error('암호가 걸린 HWP');
  const compressed = !!(flags & 0x1);
  const dist = !!(flags & 0x4);
  const store = idx(dist ? 'ViewText' : 'BodyText') || idx('BodyText');
  if (!store) {
    const prv = idx('PrvText');                 // 최후 수단: 미리보기 글자
    return prv ? cfb.readStream(prv).toString('utf16le') : '';
  }
  const sections = cfb.children(cfb.entries.indexOf(store))
    .filter((e) => /^Section\d+$/.test(e.name))
    .sort((a, b) => +a.name.slice(7) - +b.name.slice(7));
  let out = '';
  for (const sec of sections) {
    let data = cfb.readStream(sec);
    if (dist && store.name === 'ViewText') data = decodeDistSection(data);
    if (compressed) data = inflate(data);
    out += sectionText(data);
  }
  return out;
}

// ---------- ZIP (HWPX) ----------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 형식 아님');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

export function hwpxText(buf) {
  const files = unzip(buf);
  return Object.keys(files).filter((f) => /Contents\/section\d+\.xml$/i.test(f)).sort()
    .map((f) => files[f]().toString('utf8')
      .replace(/<\/hp:p>/g, '\n').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
    .join('\n');
}

// ---------- PDF ----------
let pdfjs = null;
export async function pdfText(buf, maxPages = 15) {
  if (pdfjs === null) {
    try { pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); } catch { pdfjs = false; }
  }
  if (!pdfjs) throw new Error('pdfjs-dist 미설치');
  let assets = {};
  try {
    const root = new URL('../../../', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')).pathname;
    assets = { cMapUrl: root + 'cmaps/', cMapPacked: true, standardFontDataUrl: root + 'standard_fonts/' };
  } catch {}
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0, ...assets });
  const doc = await task.promise;
  let out = '';
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    out += c.items.map((x) => x.str + (x.hasEOL ? '\n' : '')).join('') + '\n';
  }
  await (task.destroy ? task.destroy() : doc.destroy?.());
  return out;
}

// 스캔본 PDF(글자 없는 이미지)는 OCR로 읽기: poppler(pdftoppm) + tesseract(한국어) 필요
// GitHub Actions 워크플로에서 설치함. 없으면 조용히 건너뜀
export function ocrPdf(buf, maxPages = 12) {
  const has = (c) => { try { execFileSync(c, ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } };
  if (!has('pdftoppm') || !has('tesseract')) throw new Error('OCR 도구 없음');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.pdf'), buf);
    execFileSync('pdftoppm', ['-r', '200', '-gray', '-png', '-l', String(maxPages), 'a.pdf', 'p'], { cwd: dir, timeout: 180000 });
    const pages = fs.readdirSync(dir).filter((f) => /^p-\d+\.png$/.test(f)).sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
    return pages.map((f) => execFileSync('tesseract', [f, '-', '-l', 'kor+eng', '--psm', '6'],
      { cwd: dir, timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8')).join('\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// 파일 종류를 앞부분 바이트로 판별해서 글자 추출
export async function fileText(buf, name = '') {
  const head = buf.subarray(0, 4).toString('latin1');
  let t = '';
  if (head === '%PDF') {
    try { t = await pdfText(buf); } catch { t = ''; }
    if (t.replace(/\s/g, '').length < 100) t = ocrPdf(buf);   // 글자가 거의 없으면 스캔본으로 보고 OCR
  }
  else if (buf.readUInt32LE(0) === 0xE011CFD0) t = hwpText(buf);
  else if (head.startsWith('PK')) t = hwpxText(buf);
  else throw new Error('지원하지 않는 형식: ' + name);
  // 굵은 글씨를 겹쳐 찍은 PDF는 '제제제제…', '331331331…'처럼 같은 글자가 반복돼 나옴 → 1번으로 줄이기
  t = t.replace(/([^\d\s])\1{3,}/g, '$1')                      // 같은 글자 4번 이상 (숫자 제외: 1,000,000 보호)
    .replace(/(.{2,6}?)\1{3,}/g, (m, u) => {
      if (/^[\d,.\s]+$/.test(u)) return new Set(u).size > 1 && m.length >= u.length * 6 ? u : m;   // 0000 같은 숫자는 그대로
      return u;
    });
  return t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F-\uDB80-􏰀-\uDFFF]/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
