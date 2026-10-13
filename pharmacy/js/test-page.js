// test.html 전용: 기기 지원 현황과 테스트 바코드 표시
(async function () {
  var rows = [];
  function add(k, v) { rows.push('<tr><td>' + k + '</td><td>' + v + '</td></tr>'); }
  add('주소', location.origin);
  add('보안 연결(HTTPS)', window.isSecureContext ? '예' : '<strong style="color:var(--danger)">아니오 — 카메라 사용 불가</strong>');
  add('카메라 API', navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? '있음' : '없음');
  if ('BarcodeDetector' in window) {
    try {
      var f = await BarcodeDetector.getSupportedFormats();
      add('기기 내장 인식기', f.length ? f.join(', ') : '지원 형식 없음');
    } catch (e) { add('기기 내장 인식기', '오류: ' + e.message); }
  } else {
    add('기기 내장 인식기', '없음 (ZXing 사용)');
  }
  add('ZXing 라이브러리', window.ZXing ? '로드됨' : '로드 실패');
  add('영구 저장 지원', navigator.storage && navigator.storage.persist ? '있음' : '없음');
  add('브라우저', navigator.userAgent);
  document.getElementById('diag').innerHTML = rows.join('');

  var res = await fetch('test-barcodes/samples.json');
  var samples = await res.json();
  document.getElementById('samples').innerHTML = samples.map(function (s) {
    var expect = s.expected.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<div class="card sample"><h2 class="card-title">' + s.label + '</h2>' +
      '<img src="test-barcodes/' + s.file + '.svg" alt="' + s.label + '"' + (s.bcid === 'gs1datamatrix' ? ' class="dm"' : '') + '>' +
      '<p class="hint">기대 원본: <code>' + expect + '</code><br>바코드 값: <code>' + s.text + '</code></p></div>';
  }).join('');
})();
