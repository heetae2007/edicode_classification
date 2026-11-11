/**
 * 심평원 수가마스터 내보내기 (월 1회 실행)
 * MySQL 3개 테이블 -> master_YYYYMMDD.tsv.gz
 *
 * 사용법 (사내망 PC에서):
 *   npm install mysql2
 *   set DB_HOST=...  set DB_USER=...  set DB_PASSWORD=...        (Windows)
 *   node export_master.js
 *
 * 출력 형식: 탭 구분 텍스트를 gzip 압축
 *   1행 : #MASTER <탭> 기준일 <탭> 총건수
 *   n행 : EDI코드 <탭> 분류(행위/약제/치료재료) <탭> 명칭(선택)
 */
const mysql = require('mysql2');
const zlib = require('zlib');
const fs = require('fs');
const { once } = require('events');

// ---- 설정 ----
const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
};
// nameCol: 명칭 컬럼명. 모르거나 불필요하면 null (화면의 '심평원 명칭'이 비게 됨)
const TABLES = [
  { table: 'chisappcommon.MedicalFee_edi',                 cls: '행위',     codeCol: 'EdiCode', nameCol: null },
  { table: 'chisappcommon.MedicalFee_drug',                cls: '약제',     codeCol: 'EdiCode', nameCol: null },
  { table: 'chisappcommon.medicalfee_treatmentmaterial',   cls: '치료재료', codeCol: 'EdiCode', nameCol: null },
];
// --------------

const clean = v => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

(async () => {
  if (!DB.user) { console.error('DB_USER / DB_PASSWORD 환경변수를 설정하세요.'); process.exit(1); }
  const conn = mysql.createConnection(DB);
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const outName = `master_${ymd}.tsv.gz`;
  const tmpName = outName + '.tmp';

  // 총건수를 헤더에 넣기 위해 먼저 센다
  let total = 0;
  const counts = [];
  for (const t of TABLES) {
    const [rows] = await conn.promise().query(`SELECT COUNT(*) AS c FROM ${t.table} WHERE ${t.codeCol} IS NOT NULL AND TRIM(${t.codeCol}) <> ''`);
    counts.push(rows[0].c); total += rows[0].c;
  }
  console.log('건수:', TABLES.map((t, i) => `${t.cls} ${counts[i]}`).join(' / '), '/ 합계', total);

  const gz = zlib.createGzip({ level: 9 });
  const out = fs.createWriteStream(tmpName);
  gz.pipe(out);
  const write = async s => { if (!gz.write(s)) await once(gz, 'drain'); };

  const isoDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await write(`#MASTER\t${isoDate}\t${total}\n`);

  let written = 0;
  for (const t of TABLES) {
    const sql = `SELECT ${t.codeCol} AS c${t.nameCol ? `, ${t.nameCol} AS n` : ''} FROM ${t.table} WHERE ${t.codeCol} IS NOT NULL AND TRIM(${t.codeCol}) <> ''`;
    for await (const row of conn.query(sql).stream({ highWaterMark: 2000 })) {
      const code = clean(row.c).toUpperCase();
      if (!code) continue;
      await write(`${code}\t${t.cls}\t${t.nameCol ? clean(row.n) : ''}\n`);
      if (++written % 500000 === 0) console.log(written.toLocaleString(), '건 기록');
    }
  }
  gz.end();
  await once(out, 'finish');
  fs.renameSync(tmpName, outName);
  conn.end();
  console.log(`완료: ${outName} (${written.toLocaleString()}건, ${(fs.statSync(outName).size / 1048576).toFixed(1)}MB)`);
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
