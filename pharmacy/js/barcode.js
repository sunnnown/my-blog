/*
 * 바코드 문자열 해석 (순수 함수, DOM 의존 없음)
 *
 * - EAN-13 / GTIN 체크디지트 검증
 * - GS1 요소 문자열(AI) 파싱: DataMatrix·GS1-128의 (01) GTIN, (17) 사용기한, (10) 제조번호, (21) 일련번호 등
 * - 같은 제품이 EAN-13과 GS1 DataMatrix로 각각 스캔돼도 같은 약품으로 묶이도록 GTIN-14 기준 키 생성
 *
 * 브라우저에서는 window.PBS.barcode, Node(테스트)에서는 module.exports로 노출된다.
 */
(function (root) {
  'use strict';

  var GS = '\u001d';

  // 지원 형식 표시명
  var FORMAT_LABELS = {
    EAN_13: 'EAN-13',
    CODE_128: 'Code 128',
    GS1_128: 'GS1-128 (Code 128)',
    DATA_MATRIX: 'DataMatrix',
    GS1_DATA_MATRIX: 'GS1 DataMatrix',
    GTIN_14: 'GTIN-14 (수동 입력)',
    GS1_TEXT: 'GS1 요소 문자열 (수동 입력)',
    OTHER: '기타 (수동 입력)'
  };

  // 자주 쓰는 GS1 AI. fixed: 고정 길이, max: 가변 길이 최대값(GS로 끝남)
  var AI_TABLE = {
    '00': { fixed: 18, label: 'SSCC' },
    '01': { fixed: 14, label: 'GTIN' },
    '02': { fixed: 14, label: '포함 품목 GTIN' },
    '10': { max: 20, label: '제조번호(Lot)' },
    '11': { fixed: 6, label: '제조일자', date: true },
    '13': { fixed: 6, label: '포장일자', date: true },
    '15': { fixed: 6, label: '품질유지기한', date: true },
    '16': { fixed: 6, label: '판매기한', date: true },
    '17': { fixed: 6, label: '사용기한', date: true },
    '20': { fixed: 2, label: '변형번호' },
    '21': { max: 20, label: '일련번호' },
    '22': { max: 20, label: '소비자 제품 변형' },
    '30': { max: 8, label: '수량' },
    '37': { max: 8, label: '포함 수량' },
    '240': { max: 30, label: '추가 제품 ID' },
    '241': { max: 30, label: '고객 부품번호' },
    '250': { max: 30, label: '2차 일련번호' },
    '710': { max: 20, label: '국가 보험코드(DE)' },
    '711': { max: 20, label: '국가 보험코드(FR)' },
    '712': { max: 20, label: '국가 보험코드(ES)' },
    '713': { max: 20, label: '국가 보험코드(BR)' },
    '714': { max: 20, label: '국가 보험코드(PT)' },
    '7003': { fixed: 10, label: '사용기한(시각 포함)' },
    '8006': { fixed: 18, label: '구성품 ID' },
    '8020': { max: 25, label: '지불 참조번호' }
  };

  function aiDef(ai) {
    if (AI_TABLE[ai]) return AI_TABLE[ai];
    if (/^3[1-6]\d\d$/.test(ai)) return { fixed: 6, label: '측정값' };
    if (/^9\d$/.test(ai)) return { max: 90, label: '사내 정보' };
    return null;
  }

  function matchAI(data, pos) {
    for (var len = 4; len >= 2; len--) {
      var ai = data.substr(pos, len);
      if (ai.length === len && /^\d+$/.test(ai) && aiDef(ai)) return ai;
    }
    return null;
  }

  // GTIN-8/12/13/14 체크디지트 검증 (GS1 mod-10)
  function isValidGtin(code) {
    if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
    var digits = code.split('').map(Number);
    var check = digits.pop();
    var sum = 0;
    for (var i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
      sum += digits[i] * w;
    }
    return (10 - (sum % 10)) % 10 === check;
  }

  function gtinCheckDigit(body) {
    var digits = body.split('').map(Number);
    var sum = 0;
    for (var i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
      sum += digits[i] * w;
    }
    return String((10 - (sum % 10)) % 10);
  }

  function toGtin14(code) {
    if (!/^\d{8}$|^\d{12,14}$/.test(code)) return null;
    return ('00000000000000' + code).slice(-14);
  }

  // GS1 날짜(YYMMDD) → YYYY-MM-DD. DD=00이면 그 달의 마지막 날 (GS1 규칙)
  function gs1DateToIso(yymmdd) {
    if (!/^\d{6}$/.test(yymmdd)) return '';
    var yy = Number(yymmdd.slice(0, 2));
    var mm = Number(yymmdd.slice(2, 4));
    var dd = Number(yymmdd.slice(4, 6));
    if (mm < 1 || mm > 12) return '';
    var year = 2000 + yy;
    if (dd === 0) dd = new Date(year, mm, 0).getDate();
    var last = new Date(year, mm, 0).getDate();
    if (dd > last) return '';
    return year + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
  }

  // 판독기마다 붙는 심볼 식별자(]d2, ]C1 등)와 선두 FNC1(GS)을 제거
  function stripGs1Prefix(raw) {
    var s = raw;
    var hadMarker = false;
    var m = /^\]([A-Za-z])(\d)/.exec(s);
    if (m) {
      s = s.slice(3);
      // ]d2 = GS1 DataMatrix, ]C1 = GS1-128, ]e0 = GS1 DataBar, ]Q3 = GS1 QR
      hadMarker = /^(d2|C1|e0|Q3|J1)$/.test(m[1] + m[2]);
    }
    if (s.charAt(0) === GS) {
      s = s.slice(1);
      hadMarker = true;
    }
    return { data: s, hadMarker: hadMarker };
  }

  /*
   * GS1 요소 문자열 파싱.
   * 반환: { ok, fields: [{ai,label,value}], map: {ai: value}, rest, warnings }
   */
  function parseGs1(input) {
    var warnings = [];
    var fields = [];
    var map = {};
    var dupes = {};
    var data = input;

    // 사람이 읽는 형식: (01)08801234567890(17)271231(10)AB12
    if (/^\(\d{2,4}\)/.test(data)) {
      var re = /\((\d{2,4})\)([^(]*)/g;
      var mm;
      while ((mm = re.exec(data))) {
        var d = aiDef(mm[1]);
        var v = mm[2].trim();
        addField({ ai: mm[1], label: d ? d.label : '알 수 없는 AI', value: v, start: mm.index, end: re.lastIndex, term: 'paren' });
      }
      return finish();
    }

    var pos = 0;
    while (pos < data.length) {
      if (data.charAt(pos) === GS) { pos++; continue; }
      var ai = matchAI(data, pos);
      if (!ai) {
        warnings.push('해석할 수 없는 부분이 있습니다: ' + data.slice(pos).replace(/\u001d/g, '<GS>'));
        break;
      }
      var def = aiDef(ai);
      var start = pos;
      pos += ai.length;
      var value;
      var term;
      if (def.fixed) {
        value = data.substr(pos, def.fixed);
        pos += def.fixed;
        if (value.length !== def.fixed) warnings.push('(' + ai + ') 길이가 맞지 않습니다.');
        term = 'fixed';
        // 고정 길이 뒤에 GS가 와도 허용
      } else {
        var end = data.indexOf(GS, pos);
        if (end === -1) end = data.length;
        value = data.slice(pos, end);
        if (value.length > def.max) {
          warnings.push('(' + ai + ') 값이 최대 길이(' + def.max + ')보다 깁니다. 구분자가 빠졌을 수 있습니다.');
        }
        // 가변 길이 값은 GS 또는 원문 끝에서만 끝난다. 임의로 자르지 않는다.
        term = end === data.length ? 'end' : 'gs';
        pos = end;
      }
      addField({ ai: ai, label: def.label, value: value, start: start, end: pos, term: term });
    }
    return finish();

    // 같은 AI가 두 번 나오면 어느 값이 맞는지 알 수 없으므로 map에 넣지 않고 표시만 한다
    function addField(f) {
      fields.push(f);
      if (Object.prototype.hasOwnProperty.call(map, f.ai)) {
        f.duplicate = true;
        dupes[f.ai] = true;
        warnings.push('(' + f.ai + ') ' + f.label + '이(가) 두 번 이상 들어 있습니다.');
      } else {
        map[f.ai] = f.value;
      }
    }

    function finish() {
      if (map['01'] && !isValidGtin(map['01'])) warnings.push('GTIN 체크디지트가 맞지 않습니다. 다시 스캔하세요.');
      fields.forEach(function (f) {
        var def = aiDef(f.ai);
        if (def && def.date) {
          f.iso = gs1DateToIso(f.value);
          if (!f.iso) warnings.push('(' + f.ai + ') 날짜 형식이 올바르지 않습니다: ' + f.value);
        }
      });
      Object.keys(dupes).forEach(function (ai) { delete map[ai]; });
      return { ok: fields.length > 0 && !!map['01'], fields: fields, map: map, warnings: warnings };
    }
  }

  function normalizeFormat(fmt) {
    if (!fmt) return '';
    var f = String(fmt).toUpperCase().replace(/[-\s]/g, '_');
    if (f === 'EAN13') return 'EAN_13';
    if (f === 'CODE128') return 'CODE_128';
    if (f === 'DATAMATRIX') return 'DATA_MATRIX';
    return f;
  }

  /*
   * 스캔/입력 결과 분석.
   * input: { text, format, source }  (format: EAN_13 | CODE_128 | DATA_MATRIX | MANUAL ...)
   * 반환: { raw, format, formatLabel, source, gtin, gtinValid, key, lot, expiry, serial, gs1Fields, warnings }
   */
  function analyze(input) {
    var raw = String(input.text == null ? '' : input.text);
    var source = input.source || 'manual';
    var format = normalizeFormat(input.format);
    var trimmed = raw.replace(/^[\s\r\n]+|[\s\r\n]+$/g, '');
    var r = {
      raw: raw,
      format: format,
      formatLabel: '',
      source: source,
      gtin: '',
      gtinValid: false,
      key: '',
      lot: '',
      expiry: '',
      expiryRaw: '',
      lotCandidate: '',
      serial: '',
      gs1Fields: [],
      warnings: []
    };

    if (!trimmed) {
      r.warnings.push('바코드 값이 비어 있습니다.');
      return r;
    }

    var stripped = stripGs1Prefix(trimmed);
    var data = stripped.data;
    var gs1 = null;

    if (format === 'MANUAL' || format === '') {
      var compact = data.replace(/\s+/g, '');
      if (/^\d{13}$/.test(compact)) {
        format = 'EAN_13';
        data = compact;
      } else if (/^\d{14}$/.test(compact)) {
        format = 'GTIN_14';
        data = compact;
      } else if (/^\(\d{2,4}\)/.test(compact) || (/^01\d{14}/.test(compact) && compact.length > 16) || stripped.hadMarker) {
        gs1 = parseGs1(/^\(/.test(compact) ? compact : data);
        format = gs1.ok ? 'GS1_TEXT' : 'OTHER';
        if (!gs1.ok) gs1 = null;
      } else {
        format = 'OTHER';
      }
    }

    if (format === 'EAN_13') {
      r.gtin = toGtin14(data) || '';
      r.gtinValid = isValidGtin(data);
      if (!r.gtinValid) r.warnings.push('EAN-13 체크디지트가 맞지 않습니다. 숫자를 다시 확인하세요.');
    } else if (format === 'GTIN_14') {
      r.gtin = data;
      r.gtinValid = isValidGtin(data);
      if (!r.gtinValid) r.warnings.push('GTIN-14 체크디지트가 맞지 않습니다. 숫자를 다시 확인하세요.');
    } else if (format === 'DATA_MATRIX' || format === 'CODE_128') {
      // GS1 표식이 있거나 (01)로 시작하면 GS1로 해석
      if (stripped.hadMarker || /^01\d{14}/.test(data)) {
        var parsed = parseGs1(data);
        if (parsed.ok) gs1 = parsed;
      }
      if (gs1) format = format === 'DATA_MATRIX' ? 'GS1_DATA_MATRIX' : 'GS1_128';
    }

    if (gs1) {
      r.gs1Fields = gs1.fields;
      r.warnings = r.warnings.concat(gs1.warnings);
      r.gtin = gs1.map['01'] || '';
      r.gtinValid = r.gtin ? isValidGtin(r.gtin) : false;
      r.serial = gs1.map['21'] || '';
      // 원문에 GS(FNC1)나 GS1 심볼 식별자(]d2, ]C1 …)가 있으면 판독기가 구분자를 보존한 것으로 본다.
      // (ZXing은 선두 FNC1을 GS 또는 ]C1로 주고, 이후 FNC1은 GS로 준다)
      var gsKept = stripped.hadMarker || trimmed.indexOf(GS) !== -1;
      gs1.fields.forEach(function (f) {
        f.certain = f.term === 'fixed' || f.term === 'gs' || f.term === 'paren' || (f.term === 'end' && gsKept);
        if (!f.certain) {
          r.warnings.push('(' + f.ai + ') ' + f.label + ': 원문에 GS 구분자가 없어 값이 어디서 끝나는지 확정할 수 없습니다. 뒤의 항목이 섞였을 수 있습니다.');
        }
      });
      var lotField = gs1.fields.filter(function (f) { return f.ai === '10'; });
      if (gs1.map['10'] !== undefined && lotField.length === 1) {
        var lf = lotField[0];
        if (lf.certain && lf.value && lf.value.length <= 20) {
          r.lot = lf.value;
          lf.autofill = true;
        } else {
          r.lotCandidate = lf.value;
          r.warnings.push('제조번호(10)는 경계가 확실하지 않아 자동 입력하지 않았습니다. 포장에 인쇄된 제조번호를 직접 입력하세요.');
        }
      }
      var expField = gs1.fields.filter(function (f) { return f.ai === '17'; });
      if (gs1.map['17'] && expField.length === 1 && gs1DateToIso(gs1.map['17'])) {
        r.expiryRaw = gs1.map['17'];
        r.expiry = gs1DateToIso(gs1.map['17']);
        expField[0].autofill = true;
      }
      r.gs1Offset = trimmed.length - data.length; // 표식(]d2, 선두 GS) 길이: 진단 표시용
    }

    r.format = format;
    r.formatLabel = FORMAT_LABELS[format] || format;
    // 같은 제품 판별 키: 유효한 GTIN이면 GTIN-14, 아니면 원본 문자열
    r.key = r.gtin && r.gtinValid ? 'GTIN:' + r.gtin : 'RAW:' + trimmed.replace(/\u001d/g, '<GS>');
    return r;
  }

  // 화면 표시용: 보이지 않는 문자를 표식으로 바꿈
  function visibleRaw(raw) {
    return String(raw)
      .replace(/\u001d/g, '<GS>')
      .replace(/\r/g, '<CR>')
      .replace(/\n/g, '<LF>');
  }

  // GTIN-14에서 국가 접두어 안내 (제품 정보 추정은 하지 않음)
  function gtinOrigin(gtin) {
    if (!gtin || gtin.length !== 14) return '';
    var p = gtin.slice(1, 4);
    if (p === '880') return 'GS1 Korea 접두어(880)';
    if (/^2\d\d$/.test(p) || /^0[2-4]/.test(gtin.slice(1, 3))) return '사내/제한 유통 코드';
    return '';
  }

  var api = {
    GS: GS,
    FORMAT_LABELS: FORMAT_LABELS,
    isValidGtin: isValidGtin,
    gtinCheckDigit: gtinCheckDigit,
    toGtin14: toGtin14,
    gs1DateToIso: gs1DateToIso,
    parseGs1: parseGs1,
    analyze: analyze,
    visibleRaw: visibleRaw,
    gtinOrigin: gtinOrigin
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PBS = root.PBS || {};
    root.PBS.barcode = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
