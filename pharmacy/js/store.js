/*
 * 브라우저 localStorage 기반 데이터 저장소.
 *
 * 저장 구조 (키: pbs.data.v1)
 * {
 *   version: 1,
 *   products: [{ id, key, gtin, barcode, format, name, manufacturer, packUnit, it3000Box, createdAt, updatedAt }],
 *   receipts: [{ id, productId, supplier, receivedDate, quantity, unit, lot, expiry, memo,
 *                scan: { raw, format, source }, confirmedAt, createdAt, updatedAt }]
 * }
 *
 * 약품(products)과 입고 기록(receipts)을 분리해, 같은 약품의 여러 입고(공급처·입고일이 다른)를
 * 각각 별도 기록으로 남긴다. 재고 수량은 계산·저장하지 않는다.
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'pbs.data.v1';
  var VERSION = 1;

  function emptyData() {
    return { version: VERSION, products: [], receipts: [] };
  }

  function newId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function load() {
    var text;
    try {
      text = root.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      throw new Error('브라우저 저장소를 읽을 수 없습니다. (사생활 보호 모드 또는 저장소 차단 여부를 확인하세요)');
    }
    if (!text) return emptyData();
    var data = JSON.parse(text);
    if (!data || !Array.isArray(data.products) || !Array.isArray(data.receipts)) {
      throw new Error('저장된 데이터 형식이 올바르지 않습니다.');
    }
    return data;
  }

  function save(data) {
    try {
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
        throw new Error('브라우저 저장 공간이 부족합니다. 백업 후 오래된 기록을 정리하세요.');
      }
      throw new Error('저장하지 못했습니다: ' + (e && e.message ? e.message : e));
    }
  }

  function clean(v) {
    return v == null ? '' : String(v).trim();
  }

  // ---- 약품 ----

  function findProductByKey(key) {
    return load().products.find(function (p) { return p.key === key; }) || null;
  }

  function getProduct(id) {
    return load().products.find(function (p) { return p.id === id; }) || null;
  }

  function productFields(input) {
    return {
      name: clean(input.name),
      manufacturer: clean(input.manufacturer),
      packUnit: clean(input.packUnit),
      it3000Box: clean(input.it3000Box)
    };
  }

  /*
   * 키(GTIN 또는 원본 문자열)로 약품을 찾아 갱신하거나 새로 만든다.
   * scan: barcode.analyze() 결과
   */
  function upsertProductInData(data, scan, input) {
    var fields = productFields(input);
    var p = data.products.find(function (x) { return x.key === scan.key; });
    var t = nowIso();
    if (p) {
      Object.assign(p, fields, { updatedAt: t });
    } else {
      p = Object.assign({
        id: newId(),
        key: scan.key,
        gtin: scan.gtinValid ? scan.gtin : '',
        barcode: scan.raw,
        format: scan.formatLabel,
        createdAt: t,
        updatedAt: t
      }, fields);
      data.products.push(p);
    }
    return p;
  }

  function updateProduct(id, input) {
    var data = load();
    var p = data.products.find(function (x) { return x.id === id; });
    if (!p) throw new Error('약품을 찾을 수 없습니다.');
    Object.assign(p, productFields(input), { updatedAt: nowIso() });
    save(data);
    return p;
  }

  // 입고 기록이 남아 있는 약품은 cascade=true일 때만 함께 삭제
  function deleteProduct(id, cascade) {
    var data = load();
    var linked = data.receipts.filter(function (r) { return r.productId === id; });
    if (linked.length && !cascade) throw new Error('입고 기록이 있는 약품입니다.');
    data.receipts = data.receipts.filter(function (r) { return r.productId !== id; });
    data.products = data.products.filter(function (p) { return p.id !== id; });
    save(data);
    return linked.length;
  }

  // ---- 입고 기록 ----

  function receiptFields(input) {
    var q = Number(input.quantity);
    if (!clean(input.supplier)) throw new Error('공급처를 입력하세요.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(input.receivedDate))) throw new Error('입고 날짜를 입력하세요.');
    if (!isFinite(q) || q <= 0) throw new Error('입고 수량은 0보다 커야 합니다.');
    if (!clean(input.unit)) throw new Error('입고 단위를 입력하세요.');
    var expiry = clean(input.expiry);
    if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new Error('사용기한 형식이 올바르지 않습니다.');
    return {
      supplier: clean(input.supplier),
      receivedDate: clean(input.receivedDate),
      quantity: q,
      unit: clean(input.unit),
      lot: clean(input.lot),
      expiry: expiry,
      memo: clean(input.memo)
    };
  }

  // 같은 약품·공급처·입고일 기록 (중복 저장 경고용)
  function findSameDayReceipts(productKey, supplier, receivedDate, excludeId) {
    var data = load();
    var p = data.products.find(function (x) { return x.key === productKey; });
    if (!p) return [];
    return data.receipts.filter(function (r) {
      return r.productId === p.id && r.id !== excludeId &&
        r.supplier === clean(supplier) && r.receivedDate === clean(receivedDate);
    });
  }

  /*
   * 새 입고 기록 저장. 같은 약품이라도 저장할 때마다 별도 기록이 생긴다.
   */
  function addReceipt(scan, productInput, receiptInput) {
    var fields = receiptFields(receiptInput); // 검증 먼저
    var data = load();
    var product = upsertProductInData(data, scan, productInput);
    var t = nowIso();
    var r = Object.assign({
      id: newId(),
      productId: product.id,
      scan: { raw: scan.raw, format: scan.formatLabel, source: scan.source },
      confirmedAt: t,
      createdAt: t,
      updatedAt: t
    }, fields);
    data.receipts.push(r);
    save(data);
    return r;
  }

  function updateReceipt(id, productInput, receiptInput) {
    var fields = receiptFields(receiptInput);
    var data = load();
    var r = data.receipts.find(function (x) { return x.id === id; });
    if (!r) throw new Error('입고 기록을 찾을 수 없습니다.');
    var p = data.products.find(function (x) { return x.id === r.productId; });
    var t = nowIso();
    if (p && productInput) Object.assign(p, productFields(productInput), { updatedAt: t });
    Object.assign(r, fields, { updatedAt: t, confirmedAt: t });
    save(data);
    return r;
  }

  function getReceipt(id) {
    return load().receipts.find(function (r) { return r.id === id; }) || null;
  }

  function deleteReceipt(id) {
    var data = load();
    var before = data.receipts.length;
    data.receipts = data.receipts.filter(function (r) { return r.id !== id; });
    if (data.receipts.length === before) throw new Error('입고 기록을 찾을 수 없습니다.');
    save(data);
  }

  /*
   * 입고 기록 조회 (약품 정보 결합). 최신 입고일 순.
   * filter: { q, from, to, productId }
   */
  function queryReceipts(filter) {
    filter = filter || {};
    var data = load();
    var byId = {};
    data.products.forEach(function (p) { byId[p.id] = p; });
    var q = clean(filter.q).toLowerCase();
    var terms = q ? q.split(/\s+/) : [];
    return data.receipts
      .map(function (r) { return { receipt: r, product: byId[r.productId] || null }; })
      .filter(function (row) {
        var r = row.receipt;
        var p = row.product || {};
        if (filter.productId && r.productId !== filter.productId) return false;
        if (filter.from && r.receivedDate < filter.from) return false;
        if (filter.to && r.receivedDate > filter.to) return false;
        if (!terms.length) return true;
        var hay = [p.name, p.manufacturer, p.packUnit, p.it3000Box, p.gtin, p.barcode,
          r.supplier, r.lot, r.memo, r.scan && r.scan.raw].join(' ').toLowerCase();
        return terms.every(function (t) { return hay.indexOf(t) !== -1; });
      })
      .sort(function (a, b) {
        if (a.receipt.receivedDate !== b.receipt.receivedDate) {
          return a.receipt.receivedDate < b.receipt.receivedDate ? 1 : -1;
        }
        return a.receipt.createdAt < b.receipt.createdAt ? 1 : -1;
      });
  }

  // 약품 목록 + 입고 기록 건수/최근 입고일 (수량 합계는 재고로 오인될 수 있어 제공하지 않음)
  function queryProducts(q) {
    var data = load();
    var terms = clean(q).toLowerCase().split(/\s+/).filter(Boolean);
    return data.products
      .filter(function (p) {
        if (!terms.length) return true;
        var hay = [p.name, p.manufacturer, p.packUnit, p.it3000Box, p.gtin, p.barcode].join(' ').toLowerCase();
        return terms.every(function (t) { return hay.indexOf(t) !== -1; });
      })
      .map(function (p) {
        var rs = data.receipts.filter(function (r) { return r.productId === p.id; });
        var last = rs.reduce(function (m, r) { return r.receivedDate > m ? r.receivedDate : m; }, '');
        return { product: p, receiptCount: rs.length, lastReceived: last };
      })
      .sort(function (a, b) {
        return (a.product.name || '￿').localeCompare(b.product.name || '￿', 'ko');
      });
  }

  function suppliers() {
    var seen = {};
    load().receipts.forEach(function (r) { if (r.supplier) seen[r.supplier] = true; });
    return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b, 'ko'); });
  }

  function counts() {
    var d = load();
    return { products: d.products.length, receipts: d.receipts.length };
  }

  // ---- 백업 / 복원 / 삭제 ----

  function exportBackup() {
    var data = load();
    return JSON.stringify({
      app: 'pharmacy-barcode-scanner',
      exportedAt: nowIso(),
      data: data
    }, null, 2);
  }

  function validateData(d) {
    if (!d || !Array.isArray(d.products) || !Array.isArray(d.receipts)) {
      throw new Error('백업 파일 형식이 아닙니다.');
    }
    var ids = {};
    d.products.forEach(function (p) {
      if (!p || typeof p.id !== 'string' || typeof p.key !== 'string') throw new Error('약품 데이터가 손상되었습니다.');
      ids[p.id] = true;
    });
    d.receipts.forEach(function (r) {
      if (!r || typeof r.id !== 'string' || !ids[r.productId]) throw new Error('입고 기록 데이터가 손상되었습니다.');
    });
  }

  function parseBackup(text) {
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new Error('JSON 파일을 읽을 수 없습니다.');
    }
    var d = obj && obj.data ? obj.data : obj;
    validateData(d);
    return { version: VERSION, products: d.products, receipts: d.receipts };
  }

  function replaceAll(data) {
    validateData(data);
    save({ version: VERSION, products: data.products, receipts: data.receipts });
  }

  function clearAll() {
    root.localStorage.removeItem(STORAGE_KEY);
  }

  function storageBytes() {
    var t = root.localStorage.getItem(STORAGE_KEY) || '';
    return t.length * 2; // UTF-16 기준 대략값
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    load: load,
    findProductByKey: findProductByKey,
    getProduct: getProduct,
    updateProduct: updateProduct,
    deleteProduct: deleteProduct,
    findSameDayReceipts: findSameDayReceipts,
    addReceipt: addReceipt,
    updateReceipt: updateReceipt,
    getReceipt: getReceipt,
    deleteReceipt: deleteReceipt,
    queryReceipts: queryReceipts,
    queryProducts: queryProducts,
    suppliers: suppliers,
    counts: counts,
    exportBackup: exportBackup,
    parseBackup: parseBackup,
    replaceAll: replaceAll,
    clearAll: clearAll,
    storageBytes: storageBytes
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PBS = root.PBS || {};
    root.PBS.store = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
