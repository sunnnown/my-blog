# 약국 입고 스캐너 (Pharmacy Barcode Scanner) v0.1

스마트폰 카메라로 의약품 바코드를 스캔하고 **입고 기록**을 남기는 모바일 웹앱입니다.
서버·회원가입·외부 전송 없이, 데이터는 **그 스마트폰 브라우저의 localStorage에만** 저장됩니다.

> 입고 기록용 보조 도구입니다. IT3000과 연동하지 않으며, 재고 수량·조제 가능 여부를 판단하지 않습니다.
> 환자 개인정보·처방전·조제 이력은 입력하지 마세요.

## 1. 실행 · 스마트폰 접속

스마트폰 브라우저는 **HTTPS 주소에서만 카메라를 허용**합니다. 아래 중 하나로 접속하세요.

### A. GitHub Pages (권장 — 설치 없음, 정식 HTTPS)

1. GitHub 저장소 → **Settings → Pages** → Source: `Deploy from a branch`, Branch: `main` / `(root)` → Save
2. 1~2분 뒤 스마트폰에서 `https://<GitHub 사용자명>.github.io/my-blog/pharmacy/` 접속
3. (선택) 브라우저 메뉴 → **홈 화면에 추가**

페이지 파일만 공개되며, 입력한 입고 데이터는 각 기기 브라우저에만 남고 GitHub로 전송되지 않습니다.

### B. 약국 PC에서 로컬 HTTPS 서버 (같은 Wi-Fi)

```bash
python3 pharmacy/tools/serve_https.py          # Windows: py pharmacy\tools\serve_https.py
```

- 실행하면 `https://192.168.x.x:8443/` 같은 주소가 나옵니다. 스마트폰에서 그 주소로 접속하세요.
- 자체 서명 인증서라 처음에 "연결이 비공개로 설정되어 있지 않습니다" 경고가 나옵니다.
  Chrome: **고급 → (안전하지 않음)으로 이동**, Safari: **세부사항 보기 → 이 웹 사이트 방문**.
- 필요: Python 3.7+, `openssl` (macOS/Linux 기본 포함, Windows는 Git for Windows에 포함 또는 `--openssl 경로`).
- PC 방화벽에서 8443 포트 접속을 허용해야 할 수 있습니다.
- 주의: 로컬 서버 주소(IP·포트)가 바뀌면 브라우저 입장에서는 **다른 사이트**라서 저장된 기록이 보이지 않습니다.
  실사용은 주소가 고정되는 A 방식을 권장합니다.

### C. PC에서만 확인

`http://localhost`는 HTTPS 없이도 카메라가 허용됩니다.

```bash
cd pharmacy && python3 -m http.server 8000     # http://localhost:8000
```

### 실제 기기 인식 테스트

- `test.html` (예: `https://…/pharmacy/test.html`)에 **기기 지원 현황**과 **테스트 바코드**(EAN-13, GS1 DataMatrix, Code 128, GS1-128)가 있습니다.
  PC 모니터에 띄우고 스마트폰으로 스캔해 "원본 문자열"이 기대값과 같은지 확인하세요.
- 테스트 코드는 GS1 사내 전용 접두어(200)를 쓴 가짜 번호로, 실제 의약품과 겹치지 않습니다.
- `index.html?engine=zxing`으로 열면 기기 내장 인식기 대신 ZXing을 강제로 사용합니다(엔진 비교용).

## 2. 화면과 기능

| 화면 | 기능 |
| --- | --- |
| **홈** | 후면 카메라 스캔(조명·확대 지원 기기만 표시), 사진 찍어서 인식, 바코드 번호 수동 입력(블루투스/USB 리더기 입력 가능), 최근 입고 5건 |
| **입고 등록** | 바코드 원본 문자열·형식·인식 방법·GTIN 표시, GS1 항목 표, 약품 정보(약품명·제조사·포장단위·IT3000 박스번호), 입고 정보(공급처·입고일·수량·단위·제조번호·사용기한·메모), 실물 대조 확인란 |
| **기록 조회** | 입고 기록/약품 탭, 검색(약품명·바코드·공급처·제조번호·박스번호), 기간 필터, 기록 수정·삭제, 약품 정보 수정·삭제, CSV 내보내기, JSON 백업·복원, 전체 삭제 |

### 바코드 처리
- 인식 엔진: Android Chrome처럼 **기기 내장 BarcodeDetector**가 EAN-13·Code 128·DataMatrix를 모두 지원하면 그것을, 아니면(iPhone Safari 등) 내장된 **ZXing**(`vendor/`, Apache-2.0)을 사용합니다. 인터넷 CDN에 의존하지 않습니다.
- 오인식 방지: 1차원 바코드(EAN-13, Code 128)는 **같은 값이 연속 2회** 읽혀야 인정합니다. EAN-13/GTIN은 체크디지트를 검증합니다.
- GS1 DataMatrix / GS1-128: `(01)` GTIN, `(17)` 사용기한, `(10)` 제조번호, `(21)` 일련번호 등을 분해해 보여 주고, 제조번호·사용기한은 입력란에 **미리 채운 뒤 사람이 확인**하게 합니다.
- **같은 약품 판별**: EAN-13을 GTIN-14(앞에 0)로 맞춰 DataMatrix의 `(01)` GTIN과 비교하므로, 같은 GTIN이면 바코드 종류가 달라도 하나의 약품으로 묶입니다. 포장 단위가 달라 GTIN이 다르면(예: 낱개 vs 묶음 박스) 별도 약품입니다. GTIN이 없는 Code 128은 원본 문자열로 구분합니다.

### 안전 장치
- 처음 보는 바코드는 제품 정보를 추정하지 않고 빈칸(**미확인**)으로 둡니다. 목록·CSV에도 '미확인'으로 표시됩니다.
- 저장 전 "실물 포장과 대조했습니다" 확인란을 반드시 선택해야 합니다.
- 같은 약품·공급처·입고일 기록이 이미 있으면 별도 기록으로 추가할지 묻습니다. (공급처나 입고일이 다르면 항상 별도 기록)
- 수량 합계·재고는 계산하지 않습니다. 약품 목록에는 "입고 기록 N건 · 최근 입고일"만 표시합니다.
- IT3000 박스번호는 사람이 보고 적는 참고 값일 뿐, IT3000과 어떤 연동도 하지 않습니다.
- 다른 화면으로 이동하거나 앱이 백그라운드로 가면 카메라를 끕니다.

### 데이터 관리
- 저장 위치: 브라우저 localStorage (`pbs.data.v1`). 첫 저장 때 브라우저에 **영구 저장**을 요청합니다.
- **CSV**: UTF-8 BOM + CRLF로 저장해 엑셀에서 한글이 깨지지 않습니다. "엑셀용" 옵션은 GTIN·바코드를 `="0200…"` 형태로 써서 앞자리 0과 지수 표기 문제를 막습니다(다른 프로그램에서 쓸 때는 끄세요). `=`·`+`·`-`·`@`로 시작하는 값은 수식 실행 방지를 위해 앞에 `'`를 붙입니다.
- **백업/복원**: JSON 파일로 저장하고, 복원 시 현재 데이터를 백업 내용으로 **교체**합니다.
- **전체 삭제**: "삭제"를 입력해야 실행됩니다.

## 3. 파일 구조

```
pharmacy/
  index.html          앱 (홈 / 입고 등록 / 기록 조회, 해시 라우팅)
  test.html           기기 점검 + 테스트 바코드
  css/app.css         스타일 (모바일 우선, 라이트/다크)
  js/barcode.js       바코드 해석: 체크디지트, GS1 파싱, 약품 키 (DOM 없음)
  js/store.js         localStorage 저장소: 약품·입고 기록 CRUD, 검색, 백업
  js/csv.js           CSV 생성
  js/scanner.js       카메라·인식 엔진 (BarcodeDetector / ZXing), 사진 인식
  js/app.js           화면·이벤트
  vendor/             ZXing 0.21.3 UMD (Apache-2.0)
  test-barcodes/      테스트 바코드 (SVG/PNG) + samples.json
  tools/serve_https.py           로컬 HTTPS 서버
  tools/make-test-barcodes.mjs   테스트 바코드 생성 (bwip-js, 개발용)
  tests/unit.test.cjs            단위 테스트 (Node 내장 test runner)
  tests/e2e.cjs                  브라우저 테스트 (Playwright, 개발용)
```

## 4. 테스트

```bash
node --test pharmacy/tests/unit.test.cjs

# 브라우저 테스트 (Playwright 필요, 개발용)
python3 pharmacy/tools/serve_https.py --port 8443 &
(cd pharmacy && python3 -m http.server 8000 &)
NODE_PATH=<playwright가 설치된 node_modules> xvfb-run -a node pharmacy/tests/e2e.cjs
```

e2e는 Pixel 7 화면 크기로 수동 입력→저장→새로고침 유지→검색·수정·삭제→CSV(BOM·한글)→백업·복원,
사진 인식(4개 형식), 카메라 권한 거부, HTTP 접속 시 안내, Chromium 가상 카메라로 실시간 스캔(4개 형식)을 확인합니다.

## 5. 알려진 제한 · 개선 과제

- **iPhone(Safari)의 7일 규칙**: 홈 화면에 추가하지 않은 사이트는 7일간 사용하지 않으면 저장 데이터가 지워질 수 있습니다. 홈 화면에 추가하고 정기적으로 백업하세요.
- 데이터가 기기별로 따로 저장되어 여러 기기 간 공유가 되지 않습니다(다음 버전 과제).
- ZXing의 DataMatrix 인식은 작은 코드·곡면·반사에 약합니다. 확대 기능, 조명, 사진 인식을 활용하세요.
- 일부 판독기는 GS1 구분자(GS)를 빼고 돌려줄 수 있습니다. 이때 제조번호와 일련번호가 붙어 보일 수 있어 경고를 표시합니다.
- 오프라인 동작(서비스 워커)과 의약품 표준코드 DB 연동은 아직 없습니다.
