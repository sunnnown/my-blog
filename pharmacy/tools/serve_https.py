#!/usr/bin/env python3
"""
약국 입고 스캐너 – 같은 Wi-Fi의 스마트폰에서 테스트하기 위한 로컬 HTTPS 서버.

스마트폰 브라우저는 HTTPS(또는 localhost)에서만 카메라를 허용한다.
이 스크립트는 PC의 내부망 IP용 자체 서명 인증서를 만들고 pharmacy/ 폴더를 HTTPS로 제공한다.

    python3 pharmacy/tools/serve_https.py            # 기본 포트 8443
    python3 pharmacy/tools/serve_https.py --port 9443

필요: Python 3.7+, openssl 명령
  - macOS/Linux: 기본 설치되어 있음
  - Windows: Git for Windows에 포함 (C:\\Program Files\\Git\\usr\\bin\\openssl.exe)
    또는 --openssl 옵션으로 경로 지정

자체 서명 인증서이므로 스마트폰에서 처음 접속할 때 "안전하지 않음" 경고가 뜬다.
Chrome: [고급] → [... (안전하지 않음)으로 이동], Safari: [세부사항 보기] → [이 웹 사이트 방문].
"""
import argparse
import http.server
import os
import shutil
import socket
import ssl
import subprocess
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
# 인증서·개인키는 제공 폴더(pharmacy/) 밖, 사용자 홈에 둔다 (웹으로 노출되지 않게)
CERT_DIR = os.path.join(os.path.expanduser("~"), ".pharmacy-scanner", "cert")


def lan_ip():
    """기본 경로로 나가는 인터페이스의 IP (실제로 패킷을 보내지 않음)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def find_openssl(explicit):
    if explicit:
        return explicit
    found = shutil.which("openssl")
    if found:
        return found
    for p in (r"C:\Program Files\Git\usr\bin\openssl.exe", r"C:\Program Files\Git\mingw64\bin\openssl.exe"):
        if os.path.exists(p):
            return p
    return None


def ensure_cert(ip, openssl):
    os.makedirs(CERT_DIR, mode=0o700, exist_ok=True)
    cert = os.path.join(CERT_DIR, "cert.pem")
    key = os.path.join(CERT_DIR, "key.pem")
    stamp = os.path.join(CERT_DIR, "ip.txt")
    if os.path.exists(cert) and os.path.exists(key) and os.path.exists(stamp):
        with open(stamp, encoding="utf-8") as f:
            if f.read().strip() == ip:
                return cert, key
    if not openssl:
        sys.exit(
            "openssl 명령을 찾지 못했습니다.\n"
            "  - Windows: Git for Windows를 설치하거나 --openssl <경로> 로 지정하세요.\n"
            "  - 또는 README의 'GitHub Pages로 접속' 방법을 사용하세요."
        )
    san = "subjectAltName=IP:%s,IP:127.0.0.1,DNS:localhost" % ip
    cmd = [
        openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
        "-days", "825", "-keyout", key, "-out", cert,
        "-subj", "/CN=pharmacy-scanner-local", "-addext", san,
    ]
    print("자체 서명 인증서 생성:", " ".join(cmd[1:4]), "...")
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(stamp, "w", encoding="utf-8") as f:
        f.write(ip)
    return cert, key


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def send_head(self):
        # 점(.)으로 시작하는 경로(.git, .cert 등)는 제공하지 않음
        parts = urllib.parse.unquote(self.path.split("?", 1)[0].split("#", 1)[0]).split("/")
        if any(p.startswith(".") for p in parts if p):
            self.send_error(404)
            return None
        return super().send_head()

    def list_directory(self, path):
        # 폴더 목록 노출 금지 (index.html이 없는 폴더는 404)
        self.send_error(404)
        return None

    def end_headers(self):
        # 테스트 중 수정한 파일이 바로 반영되도록 캐시 사용 안 함
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


class TLSServer(http.server.ThreadingHTTPServer):
    """TLS 핸드셰이크를 연결별 작업 스레드에서 수행한다.

    리슨 소켓 자체를 감싸면 accept 단계에서 핸드셰이크가 일어나, 브라우저가 미리 열어 둔
    빈 연결 하나 때문에 다른 요청(CSS 등)이 모두 멈출 수 있다.
    """

    daemon_threads = True

    def __init__(self, addr, handler, ctx):
        super().__init__(addr, handler)
        self.ctx = ctx

    def finish_request(self, request, client_address):
        request.settimeout(30)
        try:
            tls = self.ctx.wrap_socket(request, server_side=True)
        except (ssl.SSLError, OSError):
            return  # 인증서 경고 화면에서 취소한 경우 등
        try:
            self.RequestHandlerClass(tls, client_address, self)
        finally:
            try:
                tls.close()
            except OSError:
                pass


Handler.extensions_map.update({".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml"})


def main():
    ap = argparse.ArgumentParser(description="약국 입고 스캐너 로컬 HTTPS 서버")
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--openssl", help="openssl 실행 파일 경로")
    args = ap.parse_args()

    ip = lan_ip()
    cert, key = ensure_cert(ip, find_openssl(args.openssl))

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    httpd = TLSServer((args.bind, args.port), Handler, ctx)

    print()
    print("  스마트폰(같은 Wi-Fi)에서 접속:  https://%s:%d/" % (ip, args.port))
    print("  기기 점검·테스트 바코드:        https://%s:%d/test.html" % (ip, args.port))
    print("  이 PC에서 접속:                https://localhost:%d/" % args.port)
    print()
    print("  인증서 경고가 나오면 '고급 → 계속 진행'을 선택하세요. 종료: Ctrl+C")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")


if __name__ == "__main__":
    main()
