/**
 * 단일 실행 파일(EDI_Classifier.exe) 만들기  (개발자/담당자용, 화면을 수정할 때마다 다시 실행)
 *
 *   node build_exe.js            콘솔 창 없이 실행되는 exe (일반 사용자용)
 *   node build_exe.js --console  콘솔 창이 보이는 exe (문제 확인/백신 오탐 회피용)
 *
 * 필요: Node.js 22 이상(권장 최신 LTS), 인터넷(최초 1회 esbuild 를 npx 로 내려받음)
 * 결과: dist/EDI_Classifier.exe   (서버 + 화면 + 라이브러리 + mysql2 가 모두 들어 있음)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const consoleMode = process.argv.includes('--console');
const htmlSrc = ['index.html', 'EDI코드_분류점검_예시.html'].map(n => path.join(root, n)).find(p => fs.existsSync(p));
if (!htmlSrc) { console.error('화면 HTML 파일을 찾을 수 없습니다.'); process.exit(1); }
for (const f of ['lib/xlsx.full.min.js', 'lib/jszip.min.js', 'server.js', 'export_master.js']) {
  if (!fs.existsSync(path.join(root, f))) { console.error('필요한 파일이 없습니다: ' + f); process.exit(1); }
}
if (!fs.existsSync(path.join(root, 'node_modules', 'mysql2'))) { console.error('node_modules 가 없습니다. 먼저 npm install 을 실행하세요.'); process.exit(1); }

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
// npx 는 npx.cmd 라서 셸이 필요하고, node.exe 는 경로에 공백이 있을 수 있어 셸 없이 직접 실행
const run = (cmd, args, shell = false) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell });

// 1) 서버 + mysql2 를 파일 하나로 묶기
console.log('[1/4] 번들링 (esbuild)');
run('npx', ['--yes', 'esbuild@0.25.0', 'server.js', '--bundle', '--platform=node', '--format=cjs', '--target=node22', '--minify-syntax', '--outfile=build/app.cjs', '--log-level=warning'], process.platform === 'win32');

// 2) 단일 실행 파일 설정 (화면/라이브러리를 asset 으로 포함)
console.log('[2/4] 실행 파일 구성 (Node SEA)');
const out = path.join('dist', 'EDI_Classifier.exe');
fs.writeFileSync(path.join(root, 'build', 'sea-config.json'), JSON.stringify({
  main: 'build/app.cjs',
  output: out.replace(/\\/g, '/'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  assets: {
    'index.html': path.relative(root, htmlSrc).replace(/\\/g, '/'),
    'lib/xlsx.full.min.js': 'lib/xlsx.full.min.js',
    'lib/jszip.min.js': 'lib/jszip.min.js',
  },
}, null, 2));
run(process.execPath, ['--build-sea', 'build/sea-config.json']);

// 3) 콘솔 창이 뜨지 않도록 Windows GUI 프로그램으로 표시 (PE 헤더의 Subsystem: 3=콘솔 → 2=GUI)
console.log('[3/4] ' + (consoleMode ? '콘솔 창 유지 (--console)' : '콘솔 창 숨김 처리'));
if (!consoleMode) {
  const exe = path.join(root, out), buf = fs.readFileSync(exe);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', pe, pe + 4) !== 'PE\0\0') { console.error('PE 헤더를 찾지 못했습니다.'); process.exit(1); }
  const sub = pe + 24 + 68; // COFF 헤더(24) + Optional 헤더 내 Subsystem 위치(68)
  console.log('      기존 Subsystem =', buf.readUInt16LE(sub));
  buf.writeUInt16LE(2, sub);
  fs.writeFileSync(exe, buf);
}

console.log('[4/4] 완료');
const st = fs.statSync(path.join(root, out));
console.log(`      ${out}  (${(st.size / 1048576).toFixed(1)} MB)`);
