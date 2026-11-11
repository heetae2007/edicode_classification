/**
 * 심평원 수가마스터 내보내기
 *  - 모듈: server.js 가 prepare()/stream() 을 사용
 *  - CLI : node export_master.js  (환경변수 DB_HOST, DB_USER, DB_PASSWORD) -> master_YYYYMMDD.tsv.gz
 *
 * 출력 형식: 탭 구분 텍스트를 gzip 압축
 *   1행 : #MASTER <탭> 기준일 <탭> 총건수
 *   n행 : EDI코드 <탭> 분류(행위/약제/치료재료) <탭> 명칭(선택)
 */
const mysql = require('mysql2');
const zlib = require('zlib');
const fs = require('fs');
const { once } = require('events');

// nameCol: 명칭 컬럼명. 모르거나 불필요하면 null (화면의 '심평원 명칭'이 비게 됨)
const TABLES = [
  { table: 'chisappcommon.MedicalFee_edi',               cls: '행위',     codeCol: 'EdiCode', nameCol: null },
  { table: 'chisappcommon.MedicalFee_drug',              cls: '약제',     codeCol: 'EdiCode', nameCol: null },
  { table: 'chisappcommon.medicalfee_treatmentmaterial', cls: '치료재료', codeCol: 'EdiCode', nameCol: null },
];

const clean = v => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
const where = t => `${t.codeCol} IS NOT NULL AND TRIM(${t.codeCol}) <> ''`;

function connect(cfg) {
  return mysql.createConnection({ host: cfg.host, port: cfg.port || 3306, user: cfg.user, password: cfg.password, connectTimeout: 10000 });
}

// 건수 조회 (접속/권한 오류는 여기서 먼저 드러남)
async function prepare(conn) {
  const counts = [];
  for (const t of TABLES) {
    const [rows] = await conn.promise().query(`SELECT COUNT(*) AS c FROM ${t.table} WHERE ${where(t)}`);
    counts.push(rows[0].c);
  }
  return { counts, total: counts.reduce((a, b) => a + b, 0) };
}

// sink(Writable)로 gzip 텍스트를 흘려보냄. 기록 건수를 반환
async function stream(conn, sink, prep, onProgress) {
  const gz = zlib.createGzip({ level: 6 });
  const done = new Promise((res, rej) => {
    sink.on('finish', res); sink.on('error', rej); gz.on('error', rej);
    sink.on('close', () => rej(new Error('연결이 종료되었습니다.')));
  });
  done.catch(() => {}); // 미처리 거부 방지
  gz.pipe(sink);
  const write = async s => { if (!gz.write(s)) await once(gz, 'drain'); };

  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await write(`#MASTER\t${iso}\t${prep.total}\n`);

  let written = 0;
  for (const t of TABLES) {
    const sql = `SELECT ${t.codeCol} AS c${t.nameCol ? `, ${t.nameCol} AS n` : ''} FROM ${t.table} WHERE ${where(t)}`;
    for await (const row of conn.query(sql).stream({ highWaterMark: 2000 })) {
      const code = clean(row.c).toUpperCase();
      if (!code) continue;
      await write(`${code}\t${t.cls}\t${t.nameCol ? clean(row.n) : ''}\n`);
      if (++written % 500000 === 0 && onProgress) onProgress(written);
    }
  }
  gz.end();
  await done;
  return written;
}

module.exports = { TABLES, connect, prepare, stream };

// ---- CLI ----
if (require.main === module) {
  (async () => {
    const cfg = { host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
    if (!cfg.user) { console.error('DB_USER / DB_PASSWORD 환경변수를 설정하세요.'); process.exit(1); }
    const conn = connect(cfg);
    const prep = await prepare(conn);
    console.log('건수:', TABLES.map((t, i) => `${t.cls} ${prep.counts[i]}`).join(' / '), '/ 합계', prep.total);
    const d = new Date();
    const out = `master_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.tsv.gz`;
    const tmp = out + '.tmp';
    const n = await stream(conn, fs.createWriteStream(tmp), prep, c => console.log(c.toLocaleString(), '건 기록'));
    fs.renameSync(tmp, out);
    conn.end();
    console.log(`완료: ${out} (${n.toLocaleString()}건, ${(fs.statSync(out).size / 1048576).toFixed(1)}MB)`);
  })().catch(e => { console.error('실패:', e.message); process.exit(1); });
}
