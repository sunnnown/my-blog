/*
 * 브라우저 종단 테스트 (Playwright + Chromium, 개발용 — 앱 실행에는 필요 없음)
 *
 * 준비
 *   python3 pharmacy/tools/serve_https.py --port 8443          # HTTPS 서버
 *   (cd pharmacy && python3 -m http.server 8000)               # 비보안(HTTP) 확인용
 * 실행
 *   NODE_PATH=<playwright가 설치된 node_modules> node pharmacy/tests/e2e.cjs
 *
 * 가상 카메라 테스트는 ffmpeg가 있으면 테스트 바코드 PNG로 가짜 카메라 영상(y4m)을 만들어
 * Chromium의 --use-file-for-fake-video-capture로 넣는다.
 */
const { chromium, devices } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BASE = process.env.BASE_URL || 'https://localhost:8443/';
const HTTP_BASE = process.env.HTTP_BASE_URL || 'http://pharmacy.test:8000/';
const OUT = process.env.OUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pbs-e2e-'));
const BARCODES = path.join(__dirname, '..', 'test-barcodes');
const samples = JSON.parse(fs.readFileSync(path.join(BARCODES, 'samples.json'), 'utf8'));
const mobile = devices['Pixel 7'];

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ✔ ' + name);
  } else {
    failed++;
    console.log('  ✘ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : ''));
  }
}

const visibleRaw = (s) => s.replace(/\u001d/g, '<GS>');

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

// 해시가 바뀐 뒤 hashchange 처리(화면 렌더)까지 끝났는지 기다린다
function waitView(page, view, opts) {
  return page.waitForFunction((v) => {
    const el = document.querySelector('[data-view=' + v + ']');
    return location.hash.slice(1).split('/')[0] === v && el && !el.hidden;
  }, view, opts);
}

async function manualEntry(page, code) {
  await page.goto(BASE + '#home');
  await page.fill('#manual-code', code);
  await page.click('#manual-form button[type=submit]');
  await waitView(page, 'receive');
}

async function fillReceipt(page, r) {
  if (r.supplier !== undefined) await page.fill('#f-supplier', r.supplier);
  if (r.date) await page.fill('#f-receivedDate', r.date);
  if (r.quantity !== undefined) await page.fill('#f-quantity', String(r.quantity));
  if (r.unit) await page.fill('#f-unit', r.unit);
}

async function save(page) {
  await page.check('#f-confirm');
  await page.click('#receive-submit');
}

async function mainFlow(browser) {
  console.log('\n[1] 수동 입력 → 입고 등록 → 조회/수정/삭제/CSV/백업 (Pixel 7 화면)');
  const ctx = await browser.newContext({ ...mobile, ignoreHTTPSErrors: true, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errors.push('CSP: ' + m.text()); });

  await page.goto(BASE);
  check('홈 화면 표시', await page.isVisible('#scan-start'));
  check('스타일시트 적용', (await page.evaluate(() => getComputedStyle(document.querySelector('.tabbar')).position)) === 'fixed');
  check('가로 스크롤 없음 (홈)', await noHorizontalScroll(page));
  await page.waitForFunction(() => document.getElementById('engine-info').textContent.length > 0);
  console.log('    엔진: ' + (await page.textContent('#engine-info')));
  await page.screenshot({ path: path.join(OUT, 'home-light.png'), fullPage: true });

  // 1) 처음 보는 EAN-13 → 미확인
  await manualEntry(page, '2001234567893');
  check('형식 EAN-13 표시', (await page.textContent('#scan-format')) === 'EAN-13');
  check('원본 문자열 표시', (await page.textContent('#scan-raw')) === '2001234567893');
  check('미등록 제품 → 미확인 안내', (await page.textContent('#product-status')).includes('확인되지 않았습니다'));
  check('약품명 빈칸(미확인)', (await page.inputValue('#f-name')) === '' && (await page.getAttribute('#f-name', 'placeholder')) === '미확인');
  check('가로 스크롤 없음 (입고 등록)', await noHorizontalScroll(page));
  await page.screenshot({ path: path.join(OUT, 'receive-light.png'), fullPage: true });

  await fillReceipt(page, { supplier: '지오영', quantity: 3, unit: '박스' });
  await page.click('#receive-submit');
  check('확인란 미선택 시 저장 거부', await page.isVisible('#form-error'));
  await save(page);
  await waitView(page, 'home');
  check('저장 후 홈으로 이동', true);

  // 2) 같은 약품(GS1 표기) → 다른 공급처·입고일
  await manualEntry(page, '(01)02001234567893(17)271231(10)TEST123');
  check('GS1 표기 → 같은 약품으로 인식', (await page.textContent('#product-status')).includes('이전에 등록한'));
  check('제조번호 자동 채움', (await page.inputValue('#f-lot')) === 'TEST123');
  check('사용기한 자동 채움', (await page.inputValue('#f-expiry')) === '2027-12-31');
  check('최근 공급처 자동 채움', (await page.inputValue('#f-supplier')) === '지오영');
  await page.fill('#f-name', '테스트정');
  await fillReceipt(page, { supplier: '백제약품', date: '2026-10-05', quantity: 2, unit: '박스' });
  await save(page);
  await waitView(page, 'home');

  // 3) 같은 약품·공급처·입고일 → 중복 확인창
  await manualEntry(page, '2001234567893');
  check('저장된 약품명 불러오기', (await page.inputValue('#f-name')) === '테스트정');
  await fillReceipt(page, { supplier: '지오영', quantity: 1, unit: '박스' });
  let dialogMsg = '';
  page.once('dialog', (d) => { dialogMsg = d.message(); d.accept(); });
  await save(page);
  await waitView(page, 'home');
  check('같은 공급처·입고일 중복 확인창', dialogMsg.includes('별도의 입고 기록'), dialogMsg);

  // 4) 새로고침 후 유지
  await page.reload();
  await page.goto(BASE + '#records');
  await page.reload();
  check('새로고침 후 입고 기록 3건 유지', (await page.textContent('#result-count')) === '입고 기록 3건', await page.textContent('#result-count'));
  check('가로 스크롤 없음 (기록 조회)', await noHorizontalScroll(page));
  await page.click('#tab-products');
  check('약품 1개 (EAN-13·GS1 묶임)', (await page.textContent('#result-count')) === '약품 1개', await page.textContent('#result-count'));
  check('약품 목록에 수량 합계 없음', !(await page.textContent('#product-list')).match(/합계|재고/));
  await page.click('#tab-receipts');

  // 5) 검색 / 기간
  await page.fill('#search-q', 'test123');
  check('제조번호 검색', (await page.textContent('#result-count')) === '입고 기록 1건');
  await page.fill('#search-q', '지오영');
  check('공급처 검색', (await page.textContent('#result-count')) === '입고 기록 2건');
  await page.fill('#search-q', '');
  await page.fill('#search-from', '2026-10-06');
  const afterFrom = await page.textContent('#result-count');
  await page.fill('#search-from', '');
  check('기간 필터', afterFrom === '입고 기록 2건', afterFrom);

  // 6) 수정
  await page.click('#receipt-list .record:has-text("백제약품") a:has-text("수정")');
  await waitView(page, 'receive');
  check('수정 화면 값 불러오기', (await page.inputValue('#f-supplier')) === '백제약품');
  await page.fill('#f-quantity', '5');
  await save(page);
  await waitView(page, 'records');
  check('수정 반영', (await page.textContent('#receipt-list .record:has-text("백제약품") .qty')).trim() === '5 박스');

  // 7) 삭제
  page.once('dialog', (d) => d.accept());
  await page.click('#receipt-list .record:has-text("1 박스") button:has-text("삭제")');
  check('삭제 반영', (await page.textContent('#result-count')) === '입고 기록 2건');

  // 8) 약품 정보 수정 (대화상자)
  await page.click('#tab-products');
  await page.click('button:has-text("약품 정보 수정")');
  await page.fill('dialog input[name=manufacturer]', '한국테스트제약');
  await page.click('dialog button[value=save]');
  await page.waitForFunction(() => !document.querySelector('dialog'));
  check('약품 정보 수정', (await page.textContent('#product-list')).includes('한국테스트제약'));
  await page.click('#tab-receipts');

  // 9) CSV
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
  const csvPath = path.join(OUT, csvDl.suggestedFilename());
  await csvDl.saveAs(csvPath);
  const csvBuf = fs.readFileSync(csvPath);
  const csv = csvBuf.toString('utf8');
  check('CSV 파일명/확장자', /^pharmacy-receipts_\d{8}-\d{4}\.csv$/.test(csvDl.suggestedFilename()), csvDl.suggestedFilename());
  check('CSV UTF-8 BOM', csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf);
  check('CSV 한글 헤더/값', csv.includes('입고일,공급처,약품명') && csv.includes('테스트정') && csv.includes('한국테스트제약'));
  check('CSV 미확인 표시', csv.includes(',미확인,'));
  check('CSV 2건 + 헤더', csv.trim().split('\r\n').length === 3);
  console.log('    CSV 저장: ' + csvPath);

  // 10) 백업 → 전체 삭제 → 복원
  const [bkDl] = await Promise.all([page.waitForEvent('download'), page.click('#export-backup')]);
  const bkPath = path.join(OUT, bkDl.suggestedFilename());
  await bkDl.saveAs(bkPath);
  page.once('dialog', (d) => d.accept('삭제'));
  await page.click('#clear-all');
  check('전체 삭제', (await page.textContent('#result-count')) === '입고 기록 0건');
  page.once('dialog', (d) => d.accept());
  await page.setInputFiles('#import-backup', bkPath);
  await page.waitForFunction(() => document.getElementById('result-count').textContent === '입고 기록 2건');
  check('백업 파일 복원', true);

  // 11) 다크 모드
  await page.click('#theme-toggle');
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.reload();
  check('테마 전환 유지', (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === theme);
  await page.screenshot({ path: path.join(OUT, 'records-' + theme + '.png'), fullPage: true });
  await page.click('#theme-toggle');

  check('페이지 스크립트·CSP 오류 없음', errors.length === 0, errors);
  await ctx.close();
}

async function testPageAndServer(browser) {
  console.log('\n[6] 기기 점검 페이지 · 공개 파일 점검');
  const ctx = await browser.newContext({ ...mobile, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errors.push('CSP: ' + m.text()); });
  await page.goto(BASE + 'test.html');
  await page.waitForSelector('#samples .sample img');
  check('test.html 테스트 바코드 ' + samples.length + '개 표시', (await page.$$('#samples .sample')).length === samples.length);
  check('test.html ZXing 로드됨', (await page.textContent('#diag')).includes('로드됨'));
  check('test.html 스크립트·CSP 오류 없음', errors.length === 0, errors);
  check('CSP 메타 태그', !!(await page.$('meta[http-equiv="Content-Security-Policy"]')));
  // 외부 서버로의 요청이 CSP로 차단되는지
  const blocked = await page.evaluate(() => fetch('https://example.com/').then(() => false, () => true));
  check('외부 서버 요청 차단(connect-src)', blocked);
  if (/localhost:8443/.test(BASE)) {
    for (const p of ['tools/', '.git/config', 'ca.key', 'server.key', '%2E%2E/%2E%2E/.pharmacy-scanner/cert/ca.key', 'test-barcodes/']) {
      const res = await ctx.request.get(BASE + p);
      check('로컬 서버가 ' + p + ' 제공 안 함', res.status() === 404, res.status());
    }
    const ca = await ctx.request.get(BASE + 'pharmacy-local-ca.cer');
    const caBody = await ca.body();
    check('CA 공개 인증서만 제공 (DER)', ca.status() === 200 && ca.headers()['content-type'] === 'application/x-x509-ca-cert' &&
      caBody[0] === 0x30 && !caBody.toString('latin1').includes('PRIVATE'));
  }
  await ctx.close();
}

async function photoDecode(browser) {
  console.log('\n[2] 사진 인식 (테스트 바코드 PNG)');
  const ctx = await browser.newContext({ ...mobile, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  for (const s of samples) {
    await page.goto(BASE + '#home');
    await page.setInputFiles('#photo-input', path.join(BARCODES, s.file + '.png'));
    try {
      await waitView(page, 'receive', { timeout: 15000 });
    } catch (e) {
      check(s.label + ' 사진 인식', false, await page.textContent('#camera-error'));
      continue;
    }
    const fmt = await page.textContent('#scan-format');
    const raw = await page.textContent('#scan-raw');
    check(s.file + ' → ' + fmt + ' / ' + raw, raw.replace(/^<GS>|^\][A-Za-z]\d/, '') === s.expected, s.expected);
    await page.click('#receive-cancel');
  }
  await ctx.close();
}

async function cameraDenied() {
  // 헤드리스 Chromium은 권한 요청 시 NotSupportedError를 내므로, 화면(DISPLAY, 예: xvfb-run)이 있으면
  // 실제 브라우저를 띄워 --deny-permission-prompts로 권한 거부(NotAllowedError)를 재현한다.
  const headed = !!process.env.DISPLAY;
  console.log('\n[3] 카메라 권한 거부' + (headed ? ' (실제 권한 거부)' : ' (NotAllowedError 시뮬레이션)'));
  const browser = await chromium.launch({ headless: !headed, args: ['--use-fake-device-for-media-stream', '--deny-permission-prompts'] });
  const ctx = await browser.newContext({ ...mobile, ignoreHTTPSErrors: true });
  if (!headed) {
    await ctx.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
  }
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.click('#scan-start');
  await page.waitForSelector('#camera-error:not([hidden])');
  const msg = await page.textContent('#camera-error');
  check('권한 거부 안내 표시', msg.includes('권한'), msg);
  check('스캔 시작 버튼 복귀', await page.isVisible('#scan-start'));
  check('수동 입력 계속 가능', await page.isEnabled('#manual-code'));
  await page.screenshot({ path: path.join(OUT, 'camera-denied.png') });
  await browser.close();
}

async function insecureContext() {
  console.log('\n[4] HTTP(비보안) 접속 시 안내');
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP pharmacy.test 127.0.0.1'] });
  const ctx = await browser.newContext({ ...mobile });
  const page = await ctx.newPage();
  try {
    await page.goto(HTTP_BASE);
  } catch (e) {
    check('HTTP 서버 접속 (python3 -m http.server 8000 필요)', false, e.message);
    await browser.close();
    return;
  }
  check('isSecureContext=false', !(await page.evaluate(() => window.isSecureContext)));
  await page.click('#scan-start');
  await page.waitForSelector('#camera-error:not([hidden])');
  const msg = await page.textContent('#camera-error');
  check('HTTPS 필요 안내', msg.includes('HTTPS'), msg);
  await browser.close();
}

function makeFakeVideo(sample, dir) {
  const png = path.join(BARCODES, sample.file + '.png');
  const out = path.join(dir, sample.file + '.y4m');
  const width = sample.bcid === 'gs1datamatrix' ? 260 : 540;
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', png, '-t', '2', '-r', '10',
    '-vf', `scale=${width}:-1:flags=neighbor,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x968c82,gblur=sigma=1`,
    '-pix_fmt', 'yuv420p', out]);
  return out;
}

async function fakeCamera() {
  console.log('\n[5] 가상 카메라 실시간 스캔 (Chromium fake video capture)');
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch (e) {
    console.log('  - ffmpeg 없음: 건너뜀');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbs-video-'));
  for (const s of samples.filter((x) => x.file !== 'ean13-b')) {
    const video = makeFakeVideo(s, dir);
    const browser = await chromium.launch({
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + video],
    });
    const ctx = await browser.newContext({ ...mobile, ignoreHTTPSErrors: true, permissions: ['camera'] });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.click('#scan-start');
    try {
      await waitView(page, 'receive', { timeout: 20000 });
      const raw = await page.textContent('#scan-raw');
      const fmt = await page.textContent('#scan-format');
      const src = await page.textContent('#scan-source');
      check(s.file + ' → ' + fmt + ' / ' + raw + ' (' + src + ')', raw.replace(/^<GS>|^\][A-Za-z]\d/, '') === s.expected, s.expected);
    } catch (e) {
      check(s.file + ' 실시간 인식', false, (await page.textContent('#camera-error')) || 'timeout');
    }
    await browser.close();
  }
}

(async () => {
  console.log('대상: ' + BASE + '\n결과 파일: ' + OUT);
  const browser = await chromium.launch();
  await mainFlow(browser);
  await photoDecode(browser);
  await testPageAndServer(browser);
  await browser.close();
  await cameraDenied();
  await insecureContext();
  await fakeCamera();
  console.log('\n통과 ' + passed + ' / 실패 ' + failed);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
