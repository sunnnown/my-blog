/*
 * 화면 구성과 이벤트 처리.
 * 라우트: #home, #receive, #receive/edit/<입고기록 id>, #records, #records/product/<약품 id>
 */
(function () {
  'use strict';

  var B = PBS.barcode;
  var S = PBS.store;
  var C = PBS.csv;
  var SC = PBS.scanner;

  var $ = function (id) { return document.getElementById(id); };
  var UNKNOWN = '미확인';
  var SCAN_KEY = 'pbs.currentScan';

  var state = {
    scan: readSessionScan(), // barcode.analyze() 결과
    receiveToken: null,      // 입고 등록 폼을 마지막으로 채운 대상
    editId: null,
    autoRestart: false,
    recordsTab: 'receipts',
    productFilter: null
  };

  var scanner = new SC.Scanner({
    video: $('video'),
    onResult: function (res) {
      setScanning(false);
      handleDecoded(res);
    },
    onStatus: function (msg) { $('scanner-status').textContent = msg; }
  });

  // ---------- 공통 ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function orUnknown(v) {
    return v ? esc(v) : '<span class="unknown">' + UNKNOWN + '</span>';
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function stamp() {
    return today().replace(/-/g, '') + '-' + new Date().toTimeString().slice(0, 5).replace(':', '');
  }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }

  function showError(el, msg) {
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function download(filename, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function sourceLabel(src) {
    return {
      'camera-native': '카메라 (기기 내장 인식기)',
      'camera-zxing': '카메라 (ZXing)',
      photo: '사진',
      manual: '수동 입력'
    }[src] || src || '';
  }

  function readSessionScan() {
    try {
      var t = sessionStorage.getItem(SCAN_KEY);
      return t ? JSON.parse(t) : null;
    } catch (e) {
      return null;
    }
  }

  function setScan(scan) {
    state.scan = scan;
    state.receiveToken = null;
    try {
      if (scan) sessionStorage.setItem(SCAN_KEY, JSON.stringify(scan));
      else sessionStorage.removeItem(SCAN_KEY);
    } catch (e) { /* 세션 저장 실패는 무시 */ }
  }

  function requestPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {});
    }
  }

  // ---------- 라우팅 ----------

  function parseRoute() {
    var parts = (location.hash || '#home').slice(1).split('/');
    return { view: parts[0] || 'home', action: parts[1] || '', id: decodeURIComponent(parts[2] || '') };
  }

  function route() {
    var r = parseRoute();
    if (['home', 'receive', 'records'].indexOf(r.view) === -1) r.view = 'home';

    document.querySelectorAll('.view').forEach(function (v) {
      v.hidden = v.getAttribute('data-view') !== r.view;
    });
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      if (a.getAttribute('data-nav') === r.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    if (r.view !== 'home' && scanner.running) {
      scanner.stop();
      setScanning(false);
    }

    if (r.view === 'home') renderHome();
    if (r.view === 'receive') renderReceive(r.action === 'edit' ? r.id : null);
    if (r.view === 'records') {
      state.autoRestart = false; // 기록 조회를 거쳐 홈으로 오면 카메라를 자동으로 켜지 않음
      state.productFilter = r.action === 'product' ? r.id : null;
      renderRecords();
    }
    window.scrollTo(0, 0);
  }

  // ---------- 홈 ----------

  function setScanning(on) {
    $('scan-start').hidden = on;
    $('scan-stop').hidden = !on;
    $('scanner-idle').hidden = on;
    $('scanner-tools').hidden = !on;
    $('scanner').classList.toggle('is-active', on);
    if (!on) $('scanner-status').textContent = '';
  }

  async function startScan() {
    showError($('camera-error'), '');
    $('scan-start').disabled = true;
    $('scanner-status').textContent = '카메라를 켜는 중…';
    try {
      await scanner.start();
      setScanning(true);
      var caps = scanner.capabilities();
      $('torch-btn').hidden = !caps.torch;
      $('torch-btn').setAttribute('aria-pressed', 'false');
      $('zoom-wrap').hidden = !caps.zoom;
      if (caps.zoom) {
        var z = $('zoom-range');
        z.min = caps.zoom.min;
        z.max = caps.zoom.max;
        z.step = caps.zoom.step;
        z.value = caps.zoom.value;
      }
    } catch (e) {
      scanner.stop();
      setScanning(false);
      showError($('camera-error'), e.message);
      $('manual-code').focus({ preventScroll: true });
    } finally {
      $('scan-start').disabled = false;
    }
  }

  function handleDecoded(res) {
    var scan = B.analyze({ text: res.text, format: res.format, source: res.source });
    if (navigator.vibrate) navigator.vibrate(80);
    state.autoRestart = res.source && res.source.indexOf('camera') === 0;
    setScan(scan);
    location.hash = '#receive';
  }

  function renderRecent() {
    var rows = S.queryReceipts({}).slice(0, 5);
    $('recent-list').innerHTML = rows.length
      ? rows.map(function (row) { return receiptItem(row, false); }).join('')
      : '<li class="empty">아직 저장된 입고 기록이 없습니다.</li>';
  }

  function renderHome() {
    try {
      renderRecent();
    } catch (e) {
      $('recent-list').innerHTML = '<li class="empty">' + esc(e.message) + '</li>';
    }
    SC.getEngine().then(function (eng) {
      $('engine-info').textContent = '인식 엔진: ' + eng.label + ' · 보안 연결(HTTPS): ' + (window.isSecureContext ? '예' : '아니오');
    }).catch(function (e) {
      $('engine-info').textContent = e.message;
    });
    if (state.autoRestart) {
      state.autoRestart = false;
      startScan();
    }
  }

  // ---------- 입고 등록 ----------

  var PRODUCT_FIELDS = ['name', 'manufacturer', 'packUnit', 'it3000Box'];
  var RECEIPT_FIELDS = ['supplier', 'receivedDate', 'quantity', 'unit', 'lot', 'expiry', 'memo'];

  function field(name) { return $('f-' + name); }

  function fillSupplierList() {
    $('supplier-list').innerHTML = S.suppliers().map(function (s) {
      return '<option value="' + esc(s) + '"></option>';
    }).join('');
  }

  function renderScanCard(scan) {
    $('scan-format').textContent = scan.formatLabel || scan.format || '';
    $('scan-raw').textContent = B.visibleRaw(scan.raw);
    $('scan-source').textContent = sourceLabel(scan.source);
    var gtinText = scan.gtin ? scan.gtin + (scan.gtinValid ? ' (체크디지트 정상)' : ' (체크디지트 오류)') : '없음';
    var origin = B.gtinOrigin(scan.gtin);
    $('scan-gtin').textContent = gtinText + (origin ? ' · ' + origin : '');

    var gs1 = $('scan-gs1');
    if (scan.gs1Fields && scan.gs1Fields.length) {
      gs1.innerHTML = '<table><thead><tr><th>AI</th><th>항목</th><th>값</th><th>입력란</th></tr></thead><tbody>' +
        scan.gs1Fields.map(function (f) {
          return '<tr><td>(' + esc(f.ai) + ')</td><td>' + esc(f.label) + '</td><td><code>' + esc(f.value) +
            '</code>' + (f.iso ? ' → ' + esc(f.iso) : '') + '</td><td>' + (f.autofill ? '자동 입력' : '-') + '</td></tr>';
        }).join('') + '</tbody></table>';
      gs1.hidden = false;
    } else {
      gs1.hidden = true;
      gs1.innerHTML = '';
    }

    var w = $('scan-warnings');
    var warnings = (scan.warnings || []).slice();
    if (scan.format === 'OTHER' || scan.format === 'CODE_128' || scan.format === 'DATA_MATRIX') {
      warnings.push('GTIN이 없는 바코드입니다. 원본 문자열 그대로 약품을 구분합니다.');
    }
    w.innerHTML = warnings.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('');
    w.hidden = !warnings.length;
    renderScanDiag(scan);
  }

  // 판독기가 돌려준 원문을 그대로 보여 준다 (인쇄된 문자열과 다를 수 있음)
  var TERM_LABELS = { fixed: '고정 길이', gs: 'GS 구분자', end: '원문 끝', paren: '괄호 표기' };

  function renderScanDiag(scan) {
    var raw = String(scan.raw || '');
    var codes = [];
    for (var i = 0; i < raw.length; i++) codes.push(('0' + raw.charCodeAt(i).toString(16).toUpperCase()).slice(-2));
    var gsCount = (raw.match(/\u001d/g) || []).length;
    var off = scan.gs1Offset || 0;
    var rows = (scan.gs1Fields || []).map(function (f) {
      var where = f.start == null ? '-' : (f.start + off) + '–' + (f.end + off - 1);
      return '<tr><td>(' + esc(f.ai) + ')</td><td><code>' + esc(f.value) + '</code></td><td>' + where + '</td><td>' +
        esc(TERM_LABELS[f.term] || '-') + (f.certain === false ? ' · 경계 불확실' : '') + (f.duplicate ? ' · 중복' : '') +
        '</td><td>' + (f.autofill ? '자동 입력' : '-') + '</td></tr>';
    }).join('');
    var report = JSON.stringify({
      raw: raw,
      format: scan.formatLabel || scan.format,
      source: scan.source,
      fields: (scan.gs1Fields || []).map(function (f) { return [f.ai, f.value, f.term]; })
    });
    $('scan-diag-body').innerHTML =
      '<dl class="kv">' +
      '<dt>원문 길이</dt><dd>' + raw.length + '자</dd>' +
      '<dt>GS(FNC1) 구분자</dt><dd>' + gsCount + '개' + (scan.gs1Offset ? ' · 앞 표식 ' + scan.gs1Offset + '자' : '') + '</dd>' +
      '<dt>원문</dt><dd><code class="raw">' + esc(B.visibleRaw(raw)) + '</code></dd>' +
      '<dt>문자 코드(16진)</dt><dd><code class="raw">' + esc(codes.join(' ')) + '</code></dd>' +
      '</dl>' +
      (rows ? '<div class="gs1-table"><table><thead><tr><th>AI</th><th>값</th><th>위치</th><th>끝 판단</th><th>입력란</th></tr></thead><tbody>' +
        rows + '</tbody></table></div>' : '') +
      '<label class="diag-copy">문제 보고용 (길게 눌러 복사)<textarea readonly rows="3">' + esc(report) + '</textarea></label>';
  }

  function setProductStatus(product, isNew) {
    var el = $('product-status');
    if (isNew) {
      el.className = 'status-pill warn';
      el.textContent = '처음 스캔한 바코드입니다. 제품 정보가 확인되지 않았습니다. 포장을 보고 직접 입력하세요.';
    } else {
      var missing = PRODUCT_FIELDS.slice(0, 3).filter(function (k) { return !product[k]; }).length;
      el.className = 'status-pill ' + (missing ? 'warn' : 'ok');
      el.textContent = '이전에 등록한 약품입니다' + (missing ? ' (미확인 항목 ' + missing + '개)' : '') +
        '. 실물 포장과 다시 대조하세요.';
    }
  }

  function renderReceive(editId) {
    var form = $('receive-form');
    var token = editId ? 'edit:' + editId : state.scan ? 'scan:' + state.scan.raw + ':' + state.scan.source : null;
    state.editId = editId;
    showError($('form-error'), '');

    if (!token) {
      form.hidden = true;
      $('receive-empty').hidden = false;
      $('receive-title').textContent = '입고 등록';
      return;
    }
    $('receive-empty').hidden = true;
    form.hidden = false;
    if (token === state.receiveToken) return; // 같은 대상이면 입력 중인 값 유지
    state.receiveToken = token;

    form.reset();
    fillSupplierList();
    $('gs1-prefill-hint').hidden = true;
    $('f-confirm').checked = false;

    if (editId) {
      var receipt = S.getReceipt(editId);
      if (!receipt) {
        toast('입고 기록을 찾을 수 없습니다.');
        location.hash = '#records';
        return;
      }
      var product = S.getProduct(receipt.productId) || {};
      $('receive-title').textContent = '입고 기록 수정';
      $('receive-submit').textContent = '수정 내용 저장';
      $('rescan-link').hidden = true;
      var scanInfo = receipt.scan || {};
      var re = B.analyze({ text: scanInfo.raw || '', format: guessFormatCode(scanInfo.format), source: scanInfo.source });
      re.formatLabel = scanInfo.format || re.formatLabel;
      renderScanCard(re);
      PRODUCT_FIELDS.forEach(function (k) { field(k).value = product[k] || ''; });
      RECEIPT_FIELDS.forEach(function (k) { field(k).value = receipt[k] == null ? '' : receipt[k]; });
      setProductStatus(product, false);
      return;
    }

    var scan = state.scan;
    $('receive-title').textContent = '입고 등록';
    $('receive-submit').textContent = '입고 기록 저장';
    $('rescan-link').hidden = false;
    renderScanCard(scan);
    var existing = S.findProductByKey(scan.key);
    PRODUCT_FIELDS.forEach(function (k) { field(k).value = existing ? existing[k] || '' : ''; });
    setProductStatus(existing || {}, !existing);

    field('receivedDate').value = today();
    try {
      field('supplier').value = localStorage.getItem('pbs.lastSupplier') || '';
      field('unit').value = localStorage.getItem('pbs.lastUnit') || '';
    } catch (e) { /* 무시 */ }
    if (scan.lot) field('lot').value = scan.lot;
    if (scan.expiry) field('expiry').value = scan.expiry;
    $('gs1-prefill-hint').hidden = !(scan.lot || scan.expiry);
  }

  // 저장된 형식 표시명 → analyze()용 형식 코드
  function guessFormatCode(label) {
    var codes = Object.keys(B.FORMAT_LABELS);
    for (var i = 0; i < codes.length; i++) {
      if (B.FORMAT_LABELS[codes[i]] === label) {
        var c = codes[i];
        if (c === 'GS1_DATA_MATRIX') return 'DATA_MATRIX';
        if (c === 'GS1_128') return 'CODE_128';
        if (c === 'GTIN_14' || c === 'GS1_TEXT' || c === 'OTHER') return 'MANUAL';
        return c;
      }
    }
    return 'MANUAL';
  }

  function collect(names) {
    var o = {};
    names.forEach(function (k) { o[k] = field(k).value; });
    return o;
  }

  function submitReceive(ev) {
    ev.preventDefault();
    var errorBox = $('form-error');
    showError(errorBox, '');
    var productInput = collect(PRODUCT_FIELDS);
    var receiptInput = collect(RECEIPT_FIELDS);

    if (!$('f-confirm').checked) {
      showError(errorBox, '실물 포장과 정보를 대조한 뒤 확인란을 선택하세요.');
      $('f-confirm').focus();
      return;
    }

    try {
      if (state.editId) {
        S.updateReceipt(state.editId, productInput, receiptInput);
        toast('입고 기록을 수정했습니다.');
        state.receiveToken = null;
        location.hash = '#records';
        return;
      }

      var dup = S.findSameDayReceipts(state.scan.key, receiptInput.supplier, receiptInput.receivedDate);
      if (dup.length) {
        var msg = '같은 약품·공급처·입고일 기록이 이미 ' + dup.length + '건 있습니다 (' +
          dup.map(function (d) { return d.quantity + d.unit; }).join(', ') + ').\n별도의 입고 기록으로 추가할까요?';
        if (!window.confirm(msg)) return;
      }

      S.addReceipt(state.scan, productInput, receiptInput);
      try {
        localStorage.setItem('pbs.lastSupplier', receiptInput.supplier.trim());
        localStorage.setItem('pbs.lastUnit', receiptInput.unit.trim());
      } catch (e) { /* 무시 */ }
      requestPersistentStorage();
      setScan(null);
      toast('저장했습니다. 다음 바코드를 스캔하세요.');
      location.hash = '#home';
    } catch (e) {
      showError(errorBox, e.message);
    }
  }

  function cancelReceive() {
    state.receiveToken = null;
    if (state.editId) {
      location.hash = '#records';
    } else {
      setScan(null);
      state.autoRestart = false;
      location.hash = '#home';
    }
  }

  // ---------- 기록 조회 ----------

  function receiptItem(row, withActions) {
    var r = row.receipt;
    var p = row.product || {};
    var meta = [
      '<span>' + esc(r.receivedDate) + '</span>',
      '<span>' + esc(r.supplier) + '</span>',
      '<span class="qty">' + esc(r.quantity) + ' ' + esc(r.unit) + '</span>'
    ];
    var details = [];
    details.push('제조사 ' + orUnknown(p.manufacturer));
    details.push('포장 ' + orUnknown(p.packUnit));
    if (p.it3000Box) details.push('박스 ' + esc(p.it3000Box));
    if (r.lot) details.push('제조번호 ' + esc(r.lot));
    if (r.expiry) details.push('사용기한 ' + esc(r.expiry));
    if (r.memo) details.push('메모 ' + esc(r.memo));
    return '<li class="record">' +
      '<div class="record-title">' + (p.name ? esc(p.name) : '<span class="unknown">약품명 미확인</span>') + '</div>' +
      '<div class="record-meta">' + meta.join('') + '</div>' +
      (withActions ? '<div class="record-details">' + details.join(' · ') + '</div>' +
        '<div class="record-code"><code>' + esc(p.gtin || B.visibleRaw(r.scan ? r.scan.raw : '')) + '</code></div>' +
        '<div class="record-actions">' +
        '<a class="btn btn-sm" href="#receive/edit/' + encodeURIComponent(r.id) + '">수정</a>' +
        '<button type="button" class="btn btn-sm btn-danger-text" data-del-receipt="' + esc(r.id) + '">삭제</button>' +
        '</div>' : '') +
      '</li>';
  }

  function productItem(row) {
    var p = row.product;
    return '<li class="record">' +
      '<div class="record-title">' + (p.name ? esc(p.name) : '<span class="unknown">약품명 미확인</span>') + '</div>' +
      '<div class="record-details">제조사 ' + orUnknown(p.manufacturer) + ' · 포장 ' + orUnknown(p.packUnit) +
      ' · 박스 ' + (p.it3000Box ? esc(p.it3000Box) : '-') + '</div>' +
      '<div class="record-code"><code>' + esc(p.gtin || B.visibleRaw(p.barcode)) + '</code> ' + esc(p.format || '') + '</div>' +
      '<div class="record-meta"><span>입고 기록 ' + row.receiptCount + '건</span>' +
      (row.lastReceived ? '<span>최근 입고 ' + esc(row.lastReceived) + '</span>' : '') + '</div>' +
      '<div class="record-actions">' +
      '<a class="btn btn-sm" href="#records/product/' + encodeURIComponent(p.id) + '">입고 기록 보기</a>' +
      '<button type="button" class="btn btn-sm" data-edit-product="' + esc(p.id) + '">약품 정보 수정</button>' +
      '<button type="button" class="btn btn-sm btn-danger-text" data-del-product="' + esc(p.id) + '">삭제</button>' +
      '</div></li>';
  }

  function currentReceiptRows() {
    return S.queryReceipts({
      q: $('search-q').value,
      from: $('search-from').value,
      to: $('search-to').value,
      productId: state.productFilter
    });
  }

  function renderRecords() {
    if (state.productFilter) state.recordsTab = 'receipts';
    var isReceipts = state.recordsTab === 'receipts';
    $('tab-receipts').setAttribute('aria-selected', String(isReceipts));
    $('tab-products').setAttribute('aria-selected', String(!isReceipts));
    $('receipt-list').hidden = !isReceipts;
    $('product-list').hidden = isReceipts;
    $('date-filters').hidden = !isReceipts;

    var pf = state.productFilter ? S.getProduct(state.productFilter) : null;
    $('product-filter').hidden = !pf;
    if (pf) $('product-filter-label').textContent = '약품: ' + (pf.name || UNKNOWN) + ' (' + (pf.gtin || B.visibleRaw(pf.barcode)) + ')';

    try {
      if (isReceipts) {
        var rows = currentReceiptRows();
        $('result-count').textContent = '입고 기록 ' + rows.length + '건';
        $('receipt-list').innerHTML = rows.length
          ? rows.map(function (row) { return receiptItem(row, true); }).join('')
          : '<li class="empty">조건에 맞는 입고 기록이 없습니다.</li>';
      } else {
        var prows = S.queryProducts($('search-q').value);
        $('result-count').textContent = '약품 ' + prows.length + '개';
        $('product-list').innerHTML = prows.length
          ? prows.map(productItem).join('')
          : '<li class="empty">조건에 맞는 약품이 없습니다.</li>';
      }
    } catch (e) {
      $('result-count').textContent = e.message;
    }
    renderStorageInfo();
  }

  function renderStorageInfo() {
    var info = $('storage-info');
    try {
      var c = S.counts();
      var kb = Math.ceil(S.storageBytes() / 1024);
      info.textContent = '약품 ' + c.products + '개 · 입고 기록 ' + c.receipts + '건 · 약 ' + kb + 'KB 사용';
      if (navigator.storage && navigator.storage.persisted) {
        navigator.storage.persisted().then(function (p) {
          info.textContent += ' · 브라우저 영구 저장: ' + (p ? '허용됨' : '미허용(백업 권장)');
        }).catch(function () {});
      }
    } catch (e) {
      info.textContent = e.message;
    }
  }

  function editProductDialog(id) {
    var p = S.getProduct(id);
    if (!p) return;
    var dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.innerHTML = '<form method="dialog" class="form">' +
      '<h2 class="card-title">약품 정보 수정</h2>' +
      '<p class="hint"><code>' + esc(p.gtin || B.visibleRaw(p.barcode)) + '</code></p>' +
      [['name', '약품명'], ['manufacturer', '제조사'], ['packUnit', '포장단위'], ['it3000Box', 'IT3000 박스번호']].map(function (f) {
        return '<div class="field"><label>' + f[1] + '<input name="' + f[0] + '" type="text" placeholder="미확인" value="' + esc(p[f[0]] || '') + '"></label></div>';
      }).join('') +
      '<p class="hint">이 바코드의 모든 입고 기록에 반영됩니다.</p>' +
      '<div class="btn-row"><button class="btn" value="cancel">취소</button><button class="btn btn-primary" value="save">저장</button></div>' +
      '</form>';
    document.body.appendChild(dlg);
    dlg.addEventListener('close', function () {
      if (dlg.returnValue === 'save') {
        var input = {};
        dlg.querySelectorAll('input').forEach(function (i) { input[i.name] = i.value; });
        try {
          S.updateProduct(id, input);
          toast('약품 정보를 수정했습니다.');
        } catch (e) {
          toast(e.message);
        }
        renderRecords();
      }
      dlg.remove();
    });
    dlg.showModal();
  }

  function onRecordsClick(ev) {
    var t = ev.target.closest('button');
    if (!t) return;
    var id;
    if ((id = t.getAttribute('data-del-receipt'))) {
      var r = S.getReceipt(id);
      var p = r ? S.getProduct(r.productId) : null;
      if (!r) return;
      if (!window.confirm('이 입고 기록을 삭제할까요?\n' + (p && p.name ? p.name : UNKNOWN) + ' · ' + r.receivedDate + ' · ' + r.supplier + ' · ' + r.quantity + r.unit)) return;
      S.deleteReceipt(id);
      toast('입고 기록을 삭제했습니다.');
      renderRecords();
    } else if ((id = t.getAttribute('data-edit-product'))) {
      editProductDialog(id);
    } else if ((id = t.getAttribute('data-del-product'))) {
      var prod = S.getProduct(id);
      var n = S.queryReceipts({ productId: id }).length;
      var q = n
        ? '이 약품과 연결된 입고 기록 ' + n + '건도 함께 삭제됩니다. 계속할까요?'
        : '이 약품 정보를 삭제할까요?';
      if (!window.confirm((prod && prod.name ? prod.name : UNKNOWN) + '\n' + q)) return;
      S.deleteProduct(id, true);
      toast('삭제했습니다.');
      renderRecords();
    }
  }

  // ---------- 데이터 관리 ----------

  function exportCsv() {
    var rows = currentReceiptRows();
    if (!rows.length) {
      toast('내보낼 입고 기록이 없습니다.');
      return;
    }
    var text = C.buildReceiptsCsv(rows, { excelText: $('csv-excel').checked });
    download('pharmacy-receipts_' + stamp() + '.csv', text, 'text/csv;charset=utf-8');
    toast('CSV ' + rows.length + '건을 저장했습니다.');
  }

  function exportBackup() {
    download('pharmacy-backup_' + stamp() + '.json', S.exportBackup(), 'application/json');
    try { localStorage.setItem('pbs.lastBackup', new Date().toISOString()); } catch (e) { /* 무시 */ }
    toast('백업 파일을 저장했습니다.');
  }

  function importBackup(ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    file.text().then(function (text) {
      var data = S.parseBackup(text);
      var c = S.counts();
      var msg = '백업 파일: 약품 ' + data.products.length + '개, 입고 기록 ' + data.receipts.length + '건\n' +
        '현재 데이터(약품 ' + c.products + '개, 입고 기록 ' + c.receipts + '건)를 지우고 백업 내용으로 바꿉니다.\n계속할까요?';
      if (!window.confirm(msg)) return;
      S.replaceAll(data);
      toast('백업에서 복원했습니다.');
      renderRecords();
    }).catch(function (e) {
      toast('복원 실패: ' + e.message);
    });
  }

  function clearAll() {
    var c = S.counts();
    var answer = window.prompt('약품 ' + c.products + '개와 입고 기록 ' + c.receipts + '건을 이 기기에서 모두 삭제합니다.\n되돌릴 수 없습니다. 먼저 백업 파일을 저장하세요.\n\n계속하려면 "삭제"라고 입력하세요.');
    if (answer === null) return;
    if (answer.trim() !== '삭제') {
      toast('입력이 일치하지 않아 삭제하지 않았습니다.');
      return;
    }
    S.clearAll();
    setScan(null);
    toast('모든 데이터를 삭제했습니다.');
    renderRecords();
  }

  // ---------- 테마 ----------

  function initTheme() {
    $('theme-toggle').addEventListener('click', function () {
      var root = document.documentElement;
      var current = root.getAttribute('data-theme') ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = current === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('pbs.theme', next); } catch (e) { /* 무시 */ }
    });
  }

  // ---------- 이벤트 연결 ----------

  function init() {
    initTheme();

    $('scan-start').addEventListener('click', startScan);
    $('scan-stop').addEventListener('click', function () {
      scanner.stop();
      setScanning(false);
    });
    $('torch-btn').addEventListener('click', function () {
      var btn = this;
      var on = btn.getAttribute('aria-pressed') !== 'true';
      scanner.setTorch(on).then(function () {
        btn.setAttribute('aria-pressed', String(on));
      }).catch(function () { toast('조명을 켤 수 없습니다.'); });
    });
    $('zoom-range').addEventListener('input', function () {
      scanner.setZoom(this.value).catch(function () {});
    });

    $('photo-input').addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      showError($('camera-error'), '');
      $('scanner-status').textContent = '사진에서 바코드를 찾는 중…';
      SC.decodeImageFile(file).then(function (res) {
        $('scanner-status').textContent = '';
        if (!res) {
          showError($('camera-error'), '사진에서 바코드를 찾지 못했습니다. 바코드가 화면을 크게 채우고 초점이 맞도록 다시 찍거나, 번호를 직접 입력하세요.');
          return;
        }
        handleDecoded(res);
      }).catch(function (e) {
        $('scanner-status').textContent = '';
        showError($('camera-error'), e.message);
      });
    });

    $('manual-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = $('manual-code').value;
      if (!v.trim()) return;
      $('manual-code').value = '';
      handleDecoded({ text: v, format: 'MANUAL', source: 'manual' });
    });

    $('receive-form').addEventListener('submit', submitReceive);
    $('receive-cancel').addEventListener('click', cancelReceive);
    $('rescan-link').addEventListener('click', function () {
      setScan(null);
    });

    $('tab-receipts').addEventListener('click', function () { state.recordsTab = 'receipts'; renderRecords(); });
    $('tab-products').addEventListener('click', function () {
      state.recordsTab = 'products';
      if (state.productFilter) location.hash = '#records';
      else renderRecords();
    });
    ['search-q', 'search-from', 'search-to'].forEach(function (id) {
      $(id).addEventListener('input', renderRecords);
    });
    $('product-filter-clear').addEventListener('click', function () { location.hash = '#records'; });
    $('receipt-list').addEventListener('click', onRecordsClick);
    $('product-list').addEventListener('click', onRecordsClick);

    $('export-csv').addEventListener('click', exportCsv);
    $('export-backup').addEventListener('click', exportBackup);
    $('import-backup').addEventListener('change', importBackup);
    $('clear-all').addEventListener('click', clearAll);

    // 화면이 가려지면 카메라를 끈다 (배터리·개인정보)
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && scanner.running) {
        scanner.stop();
        setScanning(false);
      }
    });

    // 다른 탭에서 데이터가 바뀌면 목록 갱신
    window.addEventListener('storage', function (ev) {
      if (ev.key === S.STORAGE_KEY) {
        var v = parseRoute().view;
        if (v === 'records') renderRecords();
        if (v === 'home') renderRecent();
      }
    });

    window.addEventListener('hashchange', route);
    route();
  }

  init();
})();
