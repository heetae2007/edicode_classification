/**
 * EDI코드 분류 점검 - 서버
 *  - 화면(HTML)과 라이브러리를 서빙하고
 *  - 화면에서 입력한 DB ID/PW 로 MySQL 에 접속해 수가마스터(.tsv.gz)를 내려줌
 *
 * 실행 방법
 *   - 단일 실행 파일: EDI_Classifier.exe 더블클릭 (build_exe.bat 으로 생성)
 *       콘솔 창 없이 실행 → 브라우저가 자동으로 열림 → 브라우저 탭을 닫으면 서버도 자동 종료
 *   - 개발/수동: start.bat 또는 node server.js
 *
 * 환경변수 (모두 선택)
 *   DB_HOST / DB_PORT   접속할 MySQL (기본: 아래 고정값. 사용자가 임의 주소로 접속하지 못하도록 서버에서 고정)
 *   PORT                기본 3000 (사용 중이면 다음 번호를 자동으로 시도)
 *   BIND                기본 127.0.0.1 (내 PC에서만). 사내 여러 명이 접속하게 하려면 0.0.0.0
 *   OPEN_BROWSER        1/0  시작 시 브라우저 자동 열기 (exe 는 기본 1)
 *   AUTO_EXIT           1/0  브라우저를 모두 닫으면 서버 자동 종료 (exe + 내 PC 전용일 때 기본 1)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { connect, prepare, stream } = require('./export_master');

// ---- 단일 실행 파일(SEA) 여부: exe 안에 화면/라이브러리가 들어 있음 ----
let sea = null;
try { const s = require('node:sea'); if (s.isSea()) sea = s; } catch (e) { /* 일반 node 실행 */ }
const baseDir = sea ? path.dirname(process.execPath) : __dirname;
const assetCache = new Map();
function readAsset(name, fallbacks = []) {
  if (assetCache.has(name)) return assetCache.get(name);
  let buf = null;
  if (sea) { try { buf = Buffer.from(sea.getAsset(name)); } catch (e) { buf = null; } }
  else for (const n of [name, ...fallbacks]) { const f = path.join(__dirname, n); if (fs.existsSync(f)) { buf = fs.readFileSync(f); break; } }
  if (buf) assetCache.set(name, buf);
  return buf;
}
function log(msg) { try { fs.appendFileSync(path.join(baseDir, 'edi_log.txt'), `${new Date().toISOString()} ${msg}\n`); } catch (e) { /* 무시 */ } }
process.on('uncaughtException', e => { log('uncaught: ' + (e && e.stack || e)); });

const BASE_PORT = +(process.env.PORT || 3000);
const BIND = process.env.BIND || '127.0.0.1';
const DB = { host: process.env.DB_HOST || 'dbacc-01.prod.ezpc.internal', port: +(process.env.DB_PORT || 5100) }; // 고정 접속 정보
const OPEN = process.env.OPEN_BROWSER ? process.env.OPEN_BROWSER === '1' : !!sea;
const AUTO_EXIT = process.env.AUTO_EXIT ? process.env.AUTO_EXIT === '1' : (!!sea && BIND === '127.0.0.1');
const LIBS = new Set(['xlsx.full.min.js', 'jszip.min.js']); // 화면이 쓰는 라이브러리 (이 이름만 서빙)
let busy = 0;
const MAX_BUSY = 2; // 동시 내보내기 제한

if (!readAsset('index.html', ['EDI코드_분류점검_예시.html'])) { log('화면 파일(index.html)을 찾을 수 없습니다.'); console.error('화면 파일(index.html)을 찾을 수 없습니다. 폴더 구성을 확인하세요.'); process.exit(1); }

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > limit) { reject(new Error('요청이 너무 큽니다.')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(new Error('잘못된 요청입니다.')); } });
    req.on('error', reject);
  });
}

function dbError(e) {
  if (e.code === 'ER_ACCESS_DENIED_ERROR') return 'DB ID 또는 비밀번호가 올바르지 않습니다.';
  if (e.code === 'ER_TABLEACCESS_DENIED_ERROR' || e.code === 'ER_DBACCESS_DENIED_ERROR') return '이 계정에는 수가마스터 테이블 조회 권한이 없습니다.';
  if (['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(e.code)) return 'DB 서버에 접속할 수 없습니다. 사내망(VPN) 연결을 확인하세요.';
  return 'DB 조회 실패: ' + e.message;
}

// ---- 브라우저 탭 생존 확인: 모든 탭이 닫히면 서버 자동 종료 (AUTO_EXIT) ----
const tabs = new Map(); // 탭 id -> 마지막 신호 시각
let hadTab = false, emptySince = Date.now();
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tabs) if (now - t > 300000) tabs.delete(id); // 5분간 신호 없으면 닫힌 것으로 간주 (백그라운드 탭 절전 고려)
  if (tabs.size > 0 || busy > 0) { emptySince = null; return; }
  if (emptySince === null) emptySince = now;
  if (AUTO_EXIT && now - emptySince > (hadTab ? 8000 : 120000)) { log('브라우저가 닫혀 서버를 종료합니다.'); process.exit(0); }
}, 2000);

async function handler(req, res) {
  try {
    const u = new URL(req.url, 'http://x'), url = u.pathname;
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readAsset('index.html', ['EDI코드_분류점검_예시.html']));
    }
    if (req.method === 'GET' && url.startsWith('/lib/') && LIBS.has(url.slice(5))) {
      const b = readAsset('lib/' + url.slice(5));
      if (!b) return json(res, 404, { error: 'lib not found' });
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      return res.end(b);
    }
    if (req.method === 'GET' && url === '/api/info') return json(res, 200, { app: 'edi-classifier', host: DB.host });
    if (url === '/api/ping') { const id = u.searchParams.get('id') || '?'; tabs.set(id, Date.now()); hadTab = true; emptySince = null; return json(res, 200, { ok: 1 }); }
    if (url === '/api/bye') { tabs.delete(u.searchParams.get('id') || '?'); res.writeHead(204); return res.end(); }

    if (req.method === 'POST' && url === '/api/sync') {
      const { user, password } = await readBody(req);
      if (!user || !password) return json(res, 400, { error: 'DB ID와 비밀번호를 입력하세요.' });
      if (busy >= MAX_BUSY) return json(res, 429, { error: '다른 사용자가 가져오는 중입니다. 잠시 후 다시 시도하세요.' });
      busy++;
      const conn = connect({ ...DB, user, password });
      let prep;
      try { prep = await prepare(conn); }
      catch (e) { conn.destroy(); busy--; return json(res, e.code === 'ER_ACCESS_DENIED_ERROR' ? 401 : 502, { error: dbError(e) }); }

      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store', 'X-Total': String(prep.total) });
      res.on('close', () => { if (!res.writableFinished) conn.destroy(); });
      try {
        const n = await stream(conn, res, prep);
        console.log(new Date().toISOString(), `sync ok user=${user} rows=${n}`); // 비밀번호는 로그에 남기지 않음
      } catch (e) {
        log('sync fail ' + e.message);
        res.destroy();
      } finally { conn.destroy(); busy--; }
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    log('handler error ' + (e && e.message));
    if (!res.headersSent) json(res, 400, { error: e.message }); else res.destroy();
  }
}

const openBrowser = port => { if (OPEN && process.platform === 'win32') exec(`start "" "http://localhost:${port}"`); };
const fail = e => { const m = '서버를 시작하지 못했습니다: ' + (e ? e.message : '사용 가능한 포트가 없습니다.'); log(m); console.error(m); process.exit(1); };

// 포트가 사용 중이면: 이미 켜진 이 프로그램이면 그 화면만 열고 종료, 다른 프로그램이면 다음 포트로
function start(port, left) {
  const server = http.createServer(handler);
  server.once('error', e => {
    if (e.code !== 'EADDRINUSE') return fail(e);
    const next = () => left > 0 ? start(port + 1, left - 1) : fail();
    http.get({ host: '127.0.0.1', port, path: '/api/info', timeout: 1500 }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { let ours = false; try { ours = JSON.parse(b).app === 'edi-classifier'; } catch (x) { /* 다른 프로그램 */ }
        if (ours) { console.log(`이미 실행 중입니다: http://localhost:${port}`); openBrowser(port); setTimeout(() => process.exit(0), 1500); } else next(); });
    }).on('error', next).on('timeout', function () { this.destroy(); });
  });
  server.listen(port, BIND, () => {
    console.log(`서버 시작: http://localhost:${port}  (DB: ${DB.host}:${DB.port})`);
    if (BIND !== '127.0.0.1') console.log(`다른 PC에서는 http://<이 PC의 IP>:${port} 로 접속하세요. (IP 확인: ipconfig)`);
    console.log(AUTO_EXIT ? '브라우저 탭을 닫으면 서버도 자동 종료됩니다.' : '이 창을 닫으면 서버가 종료됩니다.');
    openBrowser(port);
  });
}
start(BASE_PORT, 10);
