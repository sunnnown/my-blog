// 테스트용 바코드 이미지 생성 (개발용 스크립트, 앱 실행에는 필요 없음)
// 사용: npm i bwip-js (임시 폴더에서) 후
//       NODE_PATH=<임시폴더>/node_modules node tools/make-test-barcodes.mjs
// 생성된 코드는 GS1 사내/제한 유통 접두어(200)를 써서 실제 의약품과 겹치지 않는다.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const bwipjs = require('bwip-js');
const { gtinCheckDigit } = require('../js/barcode.js');

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'test-barcodes');
mkdirSync(out, { recursive: true });

const ean1 = '200123456789' + gtinCheckDigit('200123456789');
const ean2 = '200987654321' + gtinCheckDigit('200987654321');

export const samples = [
  { file: 'ean13-a', bcid: 'ean13', text: ean1, label: 'EAN-13 (테스트 약품 A)', expected: ean1, scale: 4, includetext: true },
  { file: 'gs1-datamatrix-a', bcid: 'gs1datamatrix', text: `(01)0${ean1}(17)271231(10)TEST123(21)SN000001`, label: 'GS1 DataMatrix (테스트 약품 A · 사용기한 2027-12-31 · 제조번호 TEST123)', expected: `010${ean1}1727123110TEST123<GS>21SN000001`, scale: 8 },
  { file: 'code128', bcid: 'code128', text: 'PBS-TEST-128', label: 'Code 128 (GTIN 없음)', expected: 'PBS-TEST-128', scale: 3, includetext: true },
  { file: 'gs1-128-b', bcid: 'gs1-128', text: `(01)0${ean2}(10)LOT42`, label: 'GS1-128 (테스트 약품 B · 제조번호 LOT42)', expected: `010${ean2}10LOT42`, scale: 3, includetext: true },
  { file: 'gs1-datamatrix-serial-only', bcid: 'gs1datamatrix', text: `(01)0${ean1}(17)290622(21)912602005643`, label: 'GS1 DataMatrix (일련번호만, 제조번호 없음 → 제조번호 자동 입력 안 됨이 정상)', expected: `010${ean1}1729062221912602005643`, scale: 8 },
  { file: 'gs1-datamatrix-lot-serial', bcid: 'gs1datamatrix', text: `(01)0${ean1}(17)290622(10)6020(21)912602005643`, label: 'GS1 DataMatrix (제조번호 6020 + 일련번호)', expected: `010${ean1}17290622106020<GS>21912602005643`, scale: 8 },
  { file: 'ean13-b', bcid: 'ean13', text: ean2, label: 'EAN-13 (테스트 약품 B)', expected: ean2, scale: 4, includetext: true },
];

for (const s of samples) {
  const opts = { bcid: s.bcid, text: s.text, scale: s.scale, includetext: !!s.includetext, textxalign: 'center', paddingwidth: 10, paddingheight: 10, backgroundcolor: 'FFFFFF' };
  writeFileSync(join(out, s.file + '.png'), await bwipjs.toBuffer(opts));
  writeFileSync(join(out, s.file + '.svg'), bwipjs.toSVG(opts));
}
writeFileSync(join(out, 'samples.json'), JSON.stringify(samples.map(({ file, bcid, text, label, expected }) => ({ file, bcid, text, label, expected })), null, 2) + '\n');
console.log(samples.map((s) => `${s.file}: ${s.text}`).join('\n'));
