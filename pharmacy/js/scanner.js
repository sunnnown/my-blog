/*
 * 카메라 바코드 스캐너.
 *
 * 인식 엔진
 *  1) 기기 내장 BarcodeDetector (Android Chrome 등) — EAN-13·Code 128·DataMatrix를 모두 지원할 때만 사용
 *  2) ZXing (vendor/zxing-library-*.min.js) — 그 외 모든 브라우저 (iOS Safari 포함)
 *  ?engine=zxing 쿼리로 ZXing을 강제할 수 있다 (기기 테스트용).
 *
 * 오인식 방지: 1차원 바코드(EAN-13, Code 128)는 같은 값이 연속 2회 읽혀야 결과로 인정한다.
 */
(function (root) {
  'use strict';

  var NATIVE_FORMATS = ['ean_13', 'code_128', 'data_matrix'];
  var FORMAT_FROM_NATIVE = { ean_13: 'EAN_13', code_128: 'CODE_128', data_matrix: 'DATA_MATRIX' };

  var enginePromise = null;

  function forcedEngine() {
    try {
      return new URLSearchParams(root.location.search).get('engine');
    } catch (e) {
      return null;
    }
  }

  // 사용할 인식 엔진 결정 (한 번만)
  function getEngine() {
    if (enginePromise) return enginePromise;
    enginePromise = (async function () {
      var forced = forcedEngine();
      if (forced !== 'zxing' && 'BarcodeDetector' in root) {
        try {
          var supported = await root.BarcodeDetector.getSupportedFormats();
          var ok = NATIVE_FORMATS.every(function (f) { return supported.indexOf(f) !== -1; });
          if (ok) {
            return {
              type: 'native',
              label: '기기 내장 인식기 (BarcodeDetector)',
              detector: new root.BarcodeDetector({ formats: NATIVE_FORMATS })
            };
          }
        } catch (e) { /* ZXing으로 대체 */ }
      }
      if (!root.ZXing) throw new Error('바코드 인식 라이브러리를 불러오지 못했습니다.');
      return { type: 'zxing', label: 'ZXing (JavaScript)', readers: makeZxingReaders() };
    })();
    return enginePromise;
  }

  function makeZxingReaders() {
    var Z = root.ZXing;
    var hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.DATA_MATRIX]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    hints.set(Z.DecodeHintType.ASSUME_GS1, true);
    var reader = new Z.MultiFormatReader();
    reader.setHints(hints);
    return { reader: reader };
  }

  function zxingDecodeCanvas(engine, canvas) {
    var Z = root.ZXing;
    var source = new Z.HTMLCanvasElementLuminanceSource(canvas);
    var binarizers = [Z.HybridBinarizer, Z.GlobalHistogramBinarizer];
    for (var i = 0; i < binarizers.length; i++) {
      try {
        var bitmap = new Z.BinaryBitmap(new binarizers[i](source));
        var res = engine.readers.reader.decodeWithState(bitmap);
        return { text: res.getText(), format: Z.BarcodeFormat[res.getBarcodeFormat()] };
      } catch (e) {
        // NotFound / Checksum / Format 예외는 "이 프레임에서 못 읽음"
      } finally {
        engine.readers.reader.reset();
      }
    }
    return null;
  }

  async function nativeDecode(engine, source) {
    var codes = await engine.detector.detect(source);
    if (!codes || !codes.length) return null;
    var c = codes[0];
    return { text: c.rawValue, format: FORMAT_FROM_NATIVE[c.format] || c.format.toUpperCase() };
  }

  // 이미지/영상 프레임의 일부(sx..)를 maxSide 이내로 축소해 canvas에 그린다
  function drawTo(canvas, src, sx, sy, sw, sh, maxSide) {
    var scale = Math.min(1, maxSide / Math.max(sw, sh));
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function cameraErrorMessage(err) {
    var name = err && err.name;
    if (!root.isSecureContext) {
      return '카메라는 HTTPS 주소에서만 사용할 수 있습니다. 현재 주소: ' + root.location.origin +
        ' — 안내서의 HTTPS 접속 방법을 확인하세요. 아래 수동 입력은 계속 사용할 수 있습니다.';
    }
    if (!err) return '이 브라우저는 카메라 접근을 지원하지 않습니다. Chrome 또는 Safari 최신 버전을 사용하거나 수동 입력을 사용하세요.';
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      return '카메라 권한이 거부되었습니다. 브라우저 주소창의 사이트 설정에서 카메라를 "허용"으로 바꾼 뒤 다시 시도하세요. 그동안은 사진 인식이나 수동 입력을 사용할 수 있습니다.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
      return '사용할 수 있는 카메라를 찾지 못했습니다. 수동 입력을 사용하세요.';
    }
    if (name === 'NotSupportedError') {
      return '이 브라우저에서는 카메라를 사용할 수 없습니다. Chrome(안드로이드) 또는 Safari(아이폰) 최신 버전을 사용하거나 수동 입력을 사용하세요.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      return '카메라가 다른 앱에서 사용 중이거나 시작할 수 없습니다. 다른 카메라 앱을 닫고 다시 시도하세요.';
    }
    return '카메라를 시작하지 못했습니다: ' + (err && err.message ? err.message : err);
  }

  /*
   * options: { video, onResult({text, format, source}), onStatus(msg), onError(msg) }
   */
  function Scanner(options) {
    this.video = options.video;
    this.onResult = options.onResult;
    this.onStatus = options.onStatus || function () {};
    this.onError = options.onError || function () {};
    this.canvas = root.document.createElement('canvas');
    this.stream = null;
    this.track = null;
    this.running = false;
    this.timer = null;
    this.frame = 0;
    this.pending = null; // 1차원 바코드 2회 확인용 { text, at }
  }

  Scanner.prototype.start = async function () {
    if (this.running) return;
    if (!root.isSecureContext || !root.navigator.mediaDevices || !root.navigator.mediaDevices.getUserMedia) {
      throw new Error(cameraErrorMessage(null));
    }
    var engine = await getEngine();
    this.engine = engine;
    var stream;
    try {
      stream = await root.navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });
    } catch (err) {
      throw new Error(cameraErrorMessage(err));
    }
    this.stream = stream;
    this.track = stream.getVideoTracks()[0] || null;
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    this.applyFocus();
    this.running = true;
    this.pending = null;
    this.onStatus('바코드를 화면 가운데 상자에 맞춰 주세요');
    this.loop();
  };

  Scanner.prototype.applyFocus = function () {
    var t = this.track;
    if (!t || !t.getCapabilities) return;
    try {
      var caps = t.getCapabilities();
      if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
        t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
      }
    } catch (e) { /* 일부 브라우저 미지원 */ }
  };

  Scanner.prototype.capabilities = function () {
    var t = this.track;
    var out = { torch: false, zoom: null };
    if (!t || !t.getCapabilities) return out;
    try {
      var caps = t.getCapabilities();
      out.torch = !!caps.torch;
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        var settings = t.getSettings ? t.getSettings() : {};
        out.zoom = { min: caps.zoom.min, max: Math.min(caps.zoom.max, 8), step: caps.zoom.step || 0.1, value: settings.zoom || caps.zoom.min };
      }
    } catch (e) { /* 무시 */ }
    return out;
  };

  Scanner.prototype.setTorch = function (on) {
    if (!this.track) return Promise.resolve();
    return this.track.applyConstraints({ advanced: [{ torch: !!on }] });
  };

  Scanner.prototype.setZoom = function (z) {
    if (!this.track) return Promise.resolve();
    return this.track.applyConstraints({ advanced: [{ zoom: Number(z) }] });
  };

  Scanner.prototype.stop = function () {
    this.running = false;
    clearTimeout(this.timer);
    if (this.stream) {
      this.stream.getTracks().forEach(function (t) { t.stop(); });
    }
    this.stream = null;
    this.track = null;
    if (this.video) this.video.srcObject = null;
  };

  Scanner.prototype.loop = function () {
    var self = this;
    if (!self.running) return;
    self.decodeFrame().then(function (res) {
      if (!self.running) return;
      if (res && self.accept(res)) {
        self.stop();
        self.onResult(res);
        return;
      }
      self.timer = setTimeout(function () { self.loop(); }, self.engine.type === 'native' ? 80 : 120);
    }).catch(function (e) {
      if (!self.running) return;
      self.timer = setTimeout(function () { self.loop(); }, 300);
    });
  };

  // 1차원 바코드는 같은 값이 연속 두 번 읽혀야 인정
  Scanner.prototype.accept = function (res) {
    if (res.format === 'DATA_MATRIX') return true;
    var now = Date.now();
    if (this.pending && this.pending.text === res.text && now - this.pending.at < 2000) return true;
    this.pending = { text: res.text, at: now };
    this.onStatus('인식 확인 중… 그대로 유지하세요');
    return false;
  };

  Scanner.prototype.decodeFrame = async function () {
    var v = this.video;
    var w = v.videoWidth;
    var h = v.videoHeight;
    if (!w || !h) return null;
    this.frame++;
    var res;
    if (this.engine.type === 'native') {
      res = await nativeDecode(this.engine, v);
    } else {
      // 가운데 영역(작은 DataMatrix용)과 전체 프레임을 번갈아 시도
      if (this.frame % 2 === 0) {
        var side = Math.min(w, h) * 0.6;
        drawTo(this.canvas, v, (w - side) / 2, (h - side) / 2, side, side, 900);
      } else {
        drawTo(this.canvas, v, 0, 0, w, h, 1280);
      }
      res = zxingDecodeCanvas(this.engine, this.canvas);
    }
    if (res) res.source = this.engine.type === 'native' ? 'camera-native' : 'camera-zxing';
    return res;
  };

  // ---- 사진 인식 ----
  // ZXing-js의 DataMatrix 탐지기는 사진 가운데의 큰 흰 영역을 기준으로 찾기 때문에, 바코드가 작거나
  // 주변이 복잡하면 놓친다. 그래서 사진을 바꾸지 않고 "어디를 어떤 크기·각도로 볼지"만 바꿔 다시 시도한다.
  // 값은 판독기가 오류 정정·체크섬을 통과시킨 것만 쓰며, 결과 문자열은 고치지 않는다.
  var CONTRAST = 'grayscale(1) contrast(2.5)';
  var PHOTO_TIME_LIMIT = 20000; // 자동 탐색 최대 시간(ms)

  function photoReader() {
    var Z = root.ZXing;
    var hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.DATA_MATRIX]);
    hints.set(Z.DecodeHintType.ASSUME_GS1, true);
    var reader = new Z.MultiFormatReader();
    reader.setHints(hints);
    return { reader: reader };
  }

  // src의 (sx,sy,sw,sh) 영역을 긴 변 target px로 맞추고, rot도 회전·filter 적용해 canvas에 그린다
  function drawVariant(canvas, src, sx, sy, sw, sh, target, rot, filter) {
    var sc = target / Math.max(sw, sh);
    var w = sw * sc;
    var h = sh * sc;
    var d = rot ? Math.ceil(Math.hypot(w, h)) : 0;
    canvas.width = rot ? d : Math.max(1, Math.round(w));
    canvas.height = rot ? d : Math.max(1, Math.round(h));
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.filter = filter || 'none';
    if (rot) {
      ctx.translate(d / 2, d / 2);
      ctx.rotate(rot * Math.PI / 180);
      ctx.drawImage(src, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    } else {
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
  }

  // 큰 사진은 긴 변 2000px 작업본으로 한 번만 줄인다 (이후 잘라내기·회전이 빨라짐)
  function workingCopy(img) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var sc = Math.min(1, 2000 / Math.max(w, h));
    var c = root.document.createElement('canvas');
    c.width = Math.round(w * sc);
    c.height = Math.round(h * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  // 겹치는 정사각형 창 목록. 경계(명암 변화)가 많은 창, 즉 바코드가 있을 법한 창부터 시도한다.
  function windows(work, fracs) {
    var W = work.width;
    var H = work.height;
    var tw = 160;
    var th = Math.max(1, Math.round(H * tw / W));
    var t = root.document.createElement('canvas');
    t.width = tw;
    t.height = th;
    var tctx = t.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(work, 0, 0, tw, th);
    var px = tctx.getImageData(0, 0, tw, th).data;
    var g = new Float32Array(tw * th);
    for (var i = 0; i < tw * th; i++) g[i] = px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11;
    function edge(x0, y0, x1, y1) {
      var sum = 0;
      for (var y = Math.max(1, y0); y < Math.min(th, y1); y++) {
        for (var x = Math.max(1, x0); x < Math.min(tw, x1); x++) {
          sum += Math.abs(g[y * tw + x] - g[y * tw + x - 1]) + Math.abs(g[y * tw + x] - g[(y - 1) * tw + x]);
        }
      }
      return sum / Math.max(1, (x1 - x0) * (y1 - y0));
    }
    var list = [];
    fracs.forEach(function (frac) {
      var s = Math.min(W, H) * frac;
      var step = s / 3;
      for (var y = 0; y + s <= H + 1; y += step) {
        for (var x = 0; x + s <= W + 1; x += step) {
          var k = tw / W;
          list.push({ x: x, y: y, s: s, frac: frac, score: edge(Math.floor(x * k), Math.floor(y * k), Math.ceil((x + s) * k), Math.ceil((y + s) * k)) });
        }
      }
    });
    return list.sort(function (a, b) { return b.score - a.score; });
  }

  function yieldToUI() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  /*
   * 사진에서 바코드 인식.
   * opts.region: {x, y, w, h} — 사용자가 지정한 영역 (원본 사진 픽셀 기준)
   * opts.onProgress(msg), opts.report: 시도 기록 {stage, tries, ms, steps:[{stage, tries, ok}]}
   */
  async function decodeImageFile(file, opts) {
    opts = opts || {};
    var report = opts.report || {};
    report.tries = 0;
    report.steps = [];
    var engine = await getEngine();
    var img = await loadImage(file);
    var work = workingCopy(img);
    var k = work.width / (img.naturalWidth || img.width);
    var canvas = root.document.createElement('canvas');
    var zx = root.ZXing ? photoReader() : null;
    // 1단계(원본 사진)는 기존과 같은 판독 설정(TRY_HARDER)을 그대로 쓴다
    var full = engine.type === 'zxing' ? engine.readers : (root.ZXing ? makeZxingReaders() : null);
    var t0 = Date.now();
    var W = work.width;
    var H = work.height;

    async function attempt(stage, sx, sy, sw, sh, target, rot, filter, confirm1D) {
      report.tries++;
      drawVariant(canvas, work, sx, sy, sw, sh, target, rot, filter);
      var res = null;
      if (engine.type === 'native' && !rot && !filter) res = await nativeDecode(engine, canvas);
      if (!res && zx) res = zxingDecodeCanvas({ readers: stage === '원본 사진' ? full : zx }, canvas);
      if (res && confirm1D && res.format !== 'DATA_MATRIX') {
        // 1차원 바코드는 같은 영역을 다른 크기로 다시 읽어 같은 값일 때만 인정
        drawVariant(canvas, work, sx, sy, sw, sh, Math.round(target * 1.4), rot, filter);
        var again = zxingDecodeCanvas({ readers: zx }, canvas);
        if (!again || again.text !== res.text) res = null;
      }
      if (res) {
        res.source = 'photo';
        report.stage = stage;
        report.ms = Date.now() - t0;
        res.photo = { stage: stage, tries: report.tries, ms: report.ms };
      }
      if (report.tries % 8 === 0) {
        if (opts.onProgress) opts.onProgress('사진 분석 중… ' + report.tries + '회 시도');
        await yieldToUI();
      }
      return res;
    }

    async function run(stage, list) {
      var before = report.tries;
      for (var i = 0; i < list.length; i++) {
        if (Date.now() - t0 > PHOTO_TIME_LIMIT) break;
        var a = list[i];
        var res = await attempt(stage, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]);
        if (res) {
          report.steps.push({ stage: stage, tries: report.tries - before, ok: true });
          return res;
        }
      }
      report.steps.push({ stage: stage, tries: report.tries - before, ok: false });
      return null;
    }

    var res;
    if (opts.region) {
      // 사용자 지정 영역: 여백을 조금 두고 크기·각도·대비를 바꿔 시도
      var r = opts.region;
      var pad = 0.12 * Math.max(r.w, r.h);
      var rx = Math.max(0, r.x * k - pad);
      var ry = Math.max(0, r.y * k - pad);
      var rw = Math.min(W - rx, r.w * k + pad * 2);
      var rh = Math.min(H - ry, r.h * k + pad * 2);
      var list = [];
      [0, -45, 45, -30, 30, -15, 15, 90].forEach(function (rot) {
        [null, CONTRAST].forEach(function (f) {
          [400, 300, 640].forEach(function (t) { list.push([rx, ry, rw, rh, t, rot, f, true]); });
        });
      });
      res = await run('지정 영역', list);
    } else {
      // 1단계: 기존과 같은 전체 사진 시도
      var minSide = Math.min(W, H);
      res = await run('원본 사진', [
        [0, 0, W, H, Math.max(W, H), 0, null, false],
        [0, 0, W, H, 1000, 0, null, false],
        [W * 0.2, H * 0.2, W * 0.6, H * 0.6, 1200, 0, null, false]
      ]);
      // 2단계: 사진을 겹치는 창으로 나눠 축소·확대
      var wins = windows(work, [0.6, 0.45, 0.33]);
      if (!res) {
        res = await run('영역 나눔', wins.map(function (w) { return [w.x, w.y, w.s, w.s, 480, 0, null, true]; }));
      }
      // 3단계: 회전·대비 보정 (원형 뚜껑, 기울어진 라벨 등)
      if (!res) {
        var list3 = [];
        [[0, CONTRAST], [-45, CONTRAST], [45, CONTRAST], [-30, null], [30, null]].forEach(function (v) {
          // 경계가 많은 상위 40개 창만 (시간 제한)
          wins.slice(0, 40).forEach(function (w) { list3.push([w.x, w.y, w.s, w.s, 480, v[0], v[1], true]); });
        });
        res = await run('회전·대비', list3);
      }
    }
    report.ms = Date.now() - t0;
    report.timedOut = !res && report.ms > PHOTO_TIME_LIMIT;
    return res || null;
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('이미지를 열 수 없습니다.')); };
      img.src = url;
    });
  }

  root.PBS = root.PBS || {};
  root.PBS.scanner = {
    Scanner: Scanner,
    getEngine: getEngine,
    decodeImageFile: decodeImageFile,
    cameraErrorMessage: cameraErrorMessage
  };
})(self);
