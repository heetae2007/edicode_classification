/**
 * EDI코드 분류 점검 - 사내 서버
 *  - HTML 화면과 라이브러리를 서빙하고
 *  - 화면에서 입력한 DB ID/PW 로 MySQL 에 접속해 수가마스터(.tsv.gz)를 내려줌
 *
 * 실행: start.bat 더블클릭 (또는 node server.js)
 *
 * 환경변수 (모두 선택)
 *   DB_HOST       접속할 MySQL 주소 (기본: 아래 고정값. 사용자가 임의 주소로 접속하지 못하도록 서버에서 고정)
 *   DB_PORT       기본 5100
 *   PORT          기본 3000
 *   BIND          기본 127.0.0.1 (내 PC에서만). 사내 여러 명이 접속하게 하려면 0.0.0.0
 *   OPEN_BROWSER  1 이면 시작 시 브라우저를 자동으로 연다 (Windows)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { connect, prepare, stream } = require('./export_master');

const PORT = +(process.env.PORT || 3000);
const BIND = process.env.BIND || '127.0.0.1';
const DB = { host: process.env.DB_HOST || 'dbacc-01.prod.ezpc.internal', port: +(process.env.DB_PORT || 5100) }; // 고정 접속 정보
const HTML = ['index.html', 'EDI코드_분류점검_예시.html'].map(n => path.join(__dirname, n)).find(p => fs.existsSync(p));
const LIBS = new Set(['xlsx.full.min.js', 'jszip.min.js']); // 화면이 쓰는 라이브러리 (이 이름만 서빙)
let busy = 0;
const MAX_BUSY = 2; // 동시 내보내기 제한

if (!HTML) { console.error('화면 파일(index.html)을 찾을 수 없습니다. 폴더 구성을 확인하세요.'); process.exit(1); }

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

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(HTML).pipe(res);
    }
    if (req.method === 'GET' && url.startsWith('/lib/') && LIBS.has(url.slice(5))) {
      const f = path.join(__dirname, 'lib', url.slice(5));
      if (!fs.existsSync(f)) return json(res, 404, { error: 'lib not found' });
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'GET' && url === '/api/info') return json(res, 200, { host: DB.host });

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
        console.error(new Date().toISOString(), 'sync fail', e.message);
        res.destroy();
      } finally { conn.destroy(); busy--; }
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message }); else res.destroy();
  }
});

const openUrl = `http://localhost:${PORT}`;
const openBrowser = () => { if (process.env.OPEN_BROWSER === '1' && process.platform === 'win32') exec(`start "" "${openUrl}"`); };

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { // 이미 실행 중이면 그 화면을 열어준다
    console.log(`이미 실행 중입니다. 브라우저에서 ${openUrl} 을 여세요.`);
    openBrowser();
    setTimeout(() => process.exit(0), 1500);
  } else { console.error('서버 시작 실패:', e.message); process.exit(1); }
});

server.listen(PORT, BIND, () => {
  console.log(`서버 시작: ${openUrl}  (DB: ${DB.host}:${DB.port})`);
  if (BIND !== '127.0.0.1') console.log(`다른 PC에서는 http://<이 PC의 IP>:${PORT} 로 접속하세요. (IP 확인: ipconfig)`);
  console.log('이 창을 닫으면 서버가 종료됩니다.');
  openBrowser();
});
