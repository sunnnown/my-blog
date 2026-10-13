/*
 * 입고 기록 CSV 생성.
 * - UTF-8 BOM을 붙여 엑셀에서 한글이 깨지지 않게 한다.
 * - 줄바꿈은 CRLF.
 * - =, +, -, @ 로 시작하는 값은 앞에 ' 를 붙여 수식으로 실행되지 않게 한다.
 * - excelText 옵션: 바코드·GTIN을 ="..." 형태로 써서 엑셀이 지수 표기/앞자리 0 삭제를 하지 않게 한다.
 */
(function (root) {
  'use strict';

  var BOM = '﻿';

  var COLUMNS = [
    ['입고일', function (r) { return r.receipt.receivedDate; }],
    ['공급처', function (r) { return r.receipt.supplier; }],
    ['약품명', function (r, u) { return r.product && r.product.name ? r.product.name : u; }],
    ['제조사', function (r, u) { return r.product && r.product.manufacturer ? r.product.manufacturer : u; }],
    ['포장단위', function (r, u) { return r.product && r.product.packUnit ? r.product.packUnit : u; }],
    ['IT3000 박스번호', function (r) { return r.product ? r.product.it3000Box : ''; }],
    ['입고수량', function (r) { return String(r.receipt.quantity); }],
    ['단위', function (r) { return r.receipt.unit; }],
    ['제조번호', function (r) { return r.receipt.lot; }],
    ['사용기한', function (r) { return r.receipt.expiry; }],
    ['GTIN', function (r) { return r.product ? r.product.gtin : ''; }, true],
    ['바코드 원본', function (r) { return r.receipt.scan ? r.receipt.scan.raw.replace(/\u001d/g, '<GS>') : ''; }, true],
    ['바코드 형식', function (r) { return r.receipt.scan ? r.receipt.scan.format : ''; }],
    ['메모', function (r) { return r.receipt.memo; }],
    ['등록일시', function (r) { return r.receipt.createdAt; }],
    ['수정일시', function (r) { return r.receipt.updatedAt; }]
  ];

  function escapeCell(value, asText, excelText) {
    var s = value == null ? '' : String(value);
    if (asText && excelText && /^\d+$/.test(s)) {
      // ="0880..." → 엑셀에서 문자열로 유지
      return '"=""' + s + '"""';
    }
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s) || s !== s.trim()) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /*
   * rows: store.queryReceipts() 결과 [{ receipt, product }]
   */
  function buildReceiptsCsv(rows, options) {
    options = options || {};
    var excelText = options.excelText !== false;
    var unknown = '미확인';
    var lines = [COLUMNS.map(function (c) { return escapeCell(c[0]); }).join(',')];
    rows.forEach(function (row) {
      lines.push(COLUMNS.map(function (c) {
        return escapeCell(c[1](row, unknown), c[2], excelText);
      }).join(','));
    });
    return BOM + lines.join('\r\n') + '\r\n';
  }

  var api = { buildReceiptsCsv: buildReceiptsCsv, escapeCell: escapeCell };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PBS = root.PBS || {};
    root.PBS.csv = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
