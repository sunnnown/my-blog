// 실행: node --test pharmacy/tests/
const test = require('node:test');
const assert = require('node:assert');

// 브라우저 localStorage 대용
const mem = {};
globalThis.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};

const B = require('../js/barcode.js');
const S = require('../js/store.js');
const C = require('../js/csv.js');
const GS = '\u001d';

test('EAN-13 체크디지트와 GTIN-14 변환', () => {
  assert.ok(B.isValidGtin('2001234567893'));
  assert.ok(!B.isValidGtin('2001234567890'));
  const r = B.analyze({ text: '2001234567893', format: 'EAN_13', source: 'camera-zxing' });
  assert.strictEqual(r.formatLabel, 'EAN-13');
  assert.strictEqual(r.gtin, '02001234567893');
  assert.strictEqual(r.key, 'GTIN:02001234567893');
});

test('GS1 DataMatrix (ZXing 출력: 선두 GS)', () => {
  const raw = GS + '0102001234567893' + '17271231' + '10TEST123' + GS + '21SN000001';
  const r = B.analyze({ text: raw, format: 'DATA_MATRIX', source: 'camera-zxing' });
  assert.strictEqual(r.formatLabel, 'GS1 DataMatrix');
  assert.strictEqual(r.gtin, '02001234567893');
  assert.strictEqual(r.expiry, '2027-12-31');
  assert.strictEqual(r.lot, 'TEST123');
  assert.strictEqual(r.serial, 'SN000001');
  assert.deepStrictEqual(r.warnings, []);
  // EAN-13과 같은 약품으로 묶임
  assert.strictEqual(r.key, B.analyze({ text: '2001234567893', format: 'EAN_13' }).key);
});

test('GS1 DataMatrix (심볼 식별자 ]d2, 선두 GS 없음)', () => {
  const r = B.analyze({ text: ']d20102001234567893172712001' + '0AB' + GS + '21X', format: 'DATA_MATRIX' });
  assert.strictEqual(r.formatLabel, 'GS1 DataMatrix');
  assert.strictEqual(r.expiry, '2027-12-31'); // DD=00 → 말일
  assert.strictEqual(r.lot, 'AB');
});

test('GS1-128 (]C1)', () => {
  const r = B.analyze({ text: ']C1010200987654321310LOT42', format: 'CODE_128' });
  assert.strictEqual(r.formatLabel, 'GS1-128 (Code 128)');
  assert.strictEqual(r.gtin, '02009876543213');
  assert.strictEqual(r.lot, 'LOT42');
});

test('일반 Code 128은 원본 문자열을 키로 사용', () => {
  const r = B.analyze({ text: 'PBS-TEST-128', format: 'CODE_128' });
  assert.strictEqual(r.formatLabel, 'Code 128');
  assert.strictEqual(r.key, 'RAW:PBS-TEST-128');
  assert.strictEqual(r.gtin, '');
});

test('수동 입력 판별', () => {
  assert.strictEqual(B.analyze({ text: ' 2001234567893 ', format: 'MANUAL' }).formatLabel, 'EAN-13');
  assert.strictEqual(B.analyze({ text: '02001234567893', format: 'MANUAL' }).key, 'GTIN:02001234567893');
  const hr = B.analyze({ text: '(01)02001234567893(17)271231(10)TEST123', format: 'MANUAL' });
  assert.strictEqual(hr.format, 'GS1_TEXT');
  assert.strictEqual(hr.lot, 'TEST123');
  assert.strictEqual(hr.expiry, '2027-12-31');
  const bad = B.analyze({ text: '2001234567890', format: 'MANUAL' });
  assert.ok(bad.warnings.some((w) => w.includes('체크디지트')));
  assert.ok(bad.key.startsWith('RAW:'));
  assert.strictEqual(B.analyze({ text: 'ABC-1', format: 'MANUAL' }).format, 'OTHER');
});

test('GS 없는 긴 가변 필드는 경고', () => {
  const r = B.analyze({ text: GS + '010200123456789317271231' + '10TEST12321SN000001', format: 'DATA_MATRIX' });
  assert.ok(r.warnings.length > 0);
});

test('저장소: 같은 약품의 여러 입고 기록 + 미확인 + 수정/삭제', () => {
  S.clearAll();
  const a = B.analyze({ text: '2001234567893', format: 'EAN_13', source: 'manual' });
  const dm = B.analyze({ text: GS + '01020012345678931727123110TEST123', format: 'DATA_MATRIX', source: 'camera-zxing' });
  S.addReceipt(a, { name: '', manufacturer: '' }, { supplier: '지오영', receivedDate: '2026-10-01', quantity: '3', unit: '박스' });
  S.addReceipt(dm, { name: '테스트정', manufacturer: '' }, { supplier: '백제약품', receivedDate: '2026-10-05', quantity: 2, unit: '박스', lot: 'TEST123', expiry: '2027-12-31' });
  assert.strictEqual(S.counts().products, 1);
  assert.strictEqual(S.counts().receipts, 2);
  assert.strictEqual(S.findSameDayReceipts(a.key, '지오영', '2026-10-01').length, 1);
  assert.strictEqual(S.findSameDayReceipts(a.key, '지오영', '2026-10-02').length, 0);
  const rows = S.queryReceipts({});
  assert.strictEqual(rows[0].receipt.receivedDate, '2026-10-05');
  assert.strictEqual(S.queryReceipts({ q: 'test123' }).length, 1);
  assert.strictEqual(S.queryReceipts({ from: '2026-10-02' }).length, 1);
  assert.throws(() => S.addReceipt(a, {}, { supplier: '', receivedDate: '2026-10-01', quantity: 1, unit: '개' }), /공급처/);
  assert.throws(() => S.addReceipt(a, {}, { supplier: 'x', receivedDate: '2026-10-01', quantity: 0, unit: '개' }), /수량/);
  const id = rows[1].receipt.id;
  S.updateReceipt(id, null, { supplier: '지오영', receivedDate: '2026-10-01', quantity: 4, unit: '박스' });
  assert.strictEqual(S.getReceipt(id).quantity, 4);
  S.deleteReceipt(id);
  assert.strictEqual(S.counts().receipts, 1);
  // 백업 → 삭제 → 복원
  const backup = S.exportBackup();
  S.clearAll();
  assert.strictEqual(S.counts().receipts, 0);
  S.replaceAll(S.parseBackup(backup));
  assert.strictEqual(S.counts().receipts, 1);
  assert.throws(() => S.parseBackup('{"products":[]}'), /형식/);
});

test('CSV: BOM, 한글, 미확인, 엑셀 텍스트, 수식 방지', () => {
  const rows = [{
    receipt: { receivedDate: '2026-10-01', supplier: '=HYPERLINK("x")', quantity: 3, unit: '박스', lot: '', expiry: '', memo: '쉼표,포함', createdAt: 't', updatedAt: 't', scan: { raw: '2001234567893', format: 'EAN-13' } },
    product: { name: '', manufacturer: '한국제약', packUnit: '', it3000Box: 'A-1', gtin: '02001234567893' },
  }];
  const csv = C.buildReceiptsCsv(rows, { excelText: true });
  assert.ok(csv.startsWith('﻿입고일,공급처,약품명'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes(',미확인,한국제약,미확인,A-1,'));
  assert.ok(csv.includes('"=""02001234567893"""'));
  assert.ok(csv.includes('"쉼표,포함"'));
  assert.ok(csv.endsWith('\r\n'));
  const plain = C.buildReceiptsCsv(rows, { excelText: false });
  assert.ok(plain.includes(',02001234567893,'));
});
