#!/bin/bash
# 약국 입고 스캐너 – 로컬 HTTPS 테스트 서버 (macOS)
# Finder에서 이 파일을 더블클릭하면 터미널 창이 열리고 서버가 시작됩니다.
# 종료: 이 창에서 Ctrl+C 또는 창 닫기

cd "$(dirname "$0")" || exit 1

PY="$(command -v python3)"
if [ -z "$PY" ] || ! "$PY" -c 'import ssl' >/dev/null 2>&1; then
  echo "Python 3가 필요합니다."
  echo "'명령어 라인 개발자 도구' 설치 창이 뜨면 [설치]를 누르고, 끝나면 이 파일을 다시 더블클릭하세요."
  read -r -p "Enter 키를 누르면 창을 닫습니다." _
  exit 1
fi

echo "macOS가 'python3의 수신 연결 허용' 여부를 물으면 [허용]을 누르세요."
"$PY" serve_https.py "$@"

echo
read -r -p "서버가 종료되었습니다. Enter 키를 누르면 창을 닫습니다." _
