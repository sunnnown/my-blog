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

  // 사진 파일에서 바코드 인식 (카메라 실시간 인식이 어려울 때)
  async function decodeImageFile(file) {
    var engine = await getEngine();
    var img = await loadImage(file);
    var canvas = root.document.createElement('canvas');
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var attempts = [
      [0, 0, w, h, 2000],
      [0, 0, w, h, 1000],
      [w * 0.2, h * 0.2, w * 0.6, h * 0.6, 1200]
    ];
    for (var i = 0; i < attempts.length; i++) {
      var a = attempts[i];
      drawTo(canvas, img, a[0], a[1], a[2], a[3], a[4]);
      var res = engine.type === 'native' ? await nativeDecode(engine, canvas) : zxingDecodeCanvas(engine, canvas);
      if (!res && engine.type === 'native' && root.ZXing) {
        res = zxingDecodeCanvas({ readers: makeZxingReaders() }, canvas);
      }
      if (res) {
        res.source = 'photo';
        return res;
      }
    }
    return null;
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
