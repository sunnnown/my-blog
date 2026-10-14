#!/usr/bin/env python3
"""
약국 입고 스캐너 – 같은 Wi-Fi의 스마트폰(iPhone Safari 등)에서 테스트하기 위한 로컬 HTTPS 서버.

스마트폰 브라우저는 HTTPS(또는 localhost)에서만 카메라를 허용한다.
이 스크립트는
  1) 이 컴퓨터 전용 "로컬 테스트용 CA"를 한 번 만들고 (~/.pharmacy-scanner/cert/ca.*)
  2) 그 CA로 이 컴퓨터의 내부망 IP·<이름>.local 용 서버 인증서를 발급해
  3) pharmacy/ 폴더를 HTTPS로 제공한다.
iPhone에 CA 공개 인증서(/pharmacy-local-ca.cer)를 한 번 설치·신뢰하면 경고 없이 접속된다.
개인키(CA·서버)는 사용자 홈 폴더에만 있고 웹으로 제공되지 않는다.

    python3 pharmacy/tools/serve_https.py            # 기본 포트 8443
    (macOS) Finder에서 pharmacy/tools/start-mac.command 더블클릭

필요: Python 3.7+, openssl 명령 (macOS 기본 LibreSSL 포함, Windows는 Git for Windows 또는 --openssl 경로)
사설망(192.168.x.x, 10.x.x.x, 172.16-31.x.x)과 이 컴퓨터에서 오는 요청만 받는다.
"""
import argparse
import hashlib
import http.server
import io
import ipaddress
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
# 인증서·개인키는 제공 폴더(pharmacy/) 밖, 사용자 홈에 둔다 (웹으로 노출되지 않게)
CERT_DIR = os.path.join(os.path.expanduser("~"), ".pharmacy-scanner", "cert")
CA_DOWNLOAD_PATH = "/pharmacy-local-ca.cer"  # iPhone 설치용 CA 공개 인증서 (DER)


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


def mac_local_name():
    """macOS의 Bonjour 이름(<이름>.local). iPhone이 같은 Wi-Fi에서 이 이름으로 찾을 수 있다."""
    if sys.platform != "darwin":
        return None
    try:
        name = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    return name + ".local" if name else None


def _run(openssl, args):
    r = subprocess.run([openssl] + args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("인증서 생성 실패 (openssl %s):\n%s" % (args[0], r.stderr.strip()))


def _write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _need_openssl(openssl):
    if not openssl:
        sys.exit(
            "openssl 명령을 찾지 못했습니다.\n"
            "  - Windows: Git for Windows를 설치하거나 --openssl <경로> 로 지정하세요."
        )


def ca_fingerprint(ca_crt):
    with open(ca_crt, encoding="ascii") as f:
        der = ssl.PEM_cert_to_DER_cert(f.read())
    h = hashlib.sha256(der).hexdigest().upper()
    return " ".join(h[i:i + 2] for i in range(0, len(h), 2))


# 인증서 Subject 이름은 짧은 고정값 (CN 최대 64자, macOS LibreSSL은 초과 시 생성 실패).
# 실제 접속 주소(IP·<이름>.local)는 SAN에만 넣는다.
CA_SUBJECT = "O = Pharmacy Scanner Local Test\nCN = Pharmacy Scanner Local Test CA\n"
SERVER_SUBJECT = "O = Pharmacy Scanner Local Test\nCN = pharmacy-scanner-local\n"


def valid_pair(crt, key):
    """인증서·개인키 파일이 모두 있고, 읽을 수 있고, 서로 짝이 맞는지."""
    try:
        ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(crt, key)
        return True
    except (OSError, ssl.SSLError, ValueError):
        return False


def install_pair(tmp_crt, tmp_key, crt, key):
    """임시 폴더에서 만든 파일을 검증한 뒤 제자리로 옮긴다 (실패해도 반쪽 파일이 남지 않게)."""
    if not valid_pair(tmp_crt, tmp_key):
        sys.exit("인증서 생성 결과를 확인하지 못했습니다: " + os.path.basename(crt))
    os.chmod(tmp_key, 0o600)
    os.replace(tmp_key, key)
    os.replace(tmp_crt, crt)


def ensure_ca(openssl):
    """로컬 테스트용 CA를 한 번만 만든다. (iPhone에 한 번 설치하면 IP가 바뀌어도 계속 쓸 수 있음)"""
    os.makedirs(CERT_DIR, mode=0o700, exist_ok=True)
    os.chmod(CERT_DIR, 0o700)
    ca_key = os.path.join(CERT_DIR, "ca.key")
    ca_crt = os.path.join(CERT_DIR, "ca.crt")
    if valid_pair(ca_crt, ca_key):
        return ca_crt, ca_key  # 기존 CA 재사용 (iPhone에 설치한 CA 유지)
    _need_openssl(openssl)
    # 이전 버전의 자체 서명 인증서 정리
    for old in ("cert.pem", "key.pem", "ip.txt"):
        try:
            os.remove(os.path.join(CERT_DIR, old))
        except OSError:
            pass
    with tempfile.TemporaryDirectory(dir=CERT_DIR) as tmp:
        cnf = os.path.join(tmp, "ca.cnf")
        # macOS 기본 LibreSSL은 -subj만 쓰고 [dn]이 비어 있으면 실패하므로 이름을 설정 파일에 넣는다
        _write(cnf, "[req]\ndistinguished_name = dn\nprompt = no\n[dn]\n" + CA_SUBJECT +
                    "[v3_ca]\nbasicConstraints = critical, CA:TRUE, pathlen:0\n"
                    "keyUsage = critical, keyCertSign, cRLSign\nsubjectKeyIdentifier = hash\n")
        tmp_key, tmp_crt = os.path.join(tmp, "ca.key"), os.path.join(tmp, "ca.crt")
        old_umask = os.umask(0o077)
        try:
            _run(openssl, ["req", "-x509", "-new", "-nodes", "-newkey", "rsa:2048", "-sha256",
                           "-days", "825", "-config", cnf, "-extensions", "v3_ca",
                           "-keyout", tmp_key, "-out", tmp_crt])
        finally:
            os.umask(old_umask)
        install_pair(tmp_crt, tmp_key, ca_crt, ca_key)
    print("로컬 테스트용 CA를 만들었습니다:", ca_crt)
    return ca_crt, ca_key


def ensure_server_cert(openssl, ca_crt, ca_key, ip, dns_names):
    """CA로 서버 인증서를 발급한다. IP·이름이 바뀌면 다시 발급한다 (CA는 그대로)."""
    crt = os.path.join(CERT_DIR, "server.crt")
    key = os.path.join(CERT_DIR, "server.key")
    stamp = os.path.join(CERT_DIR, "server.txt")
    ips = [ip] + (["127.0.0.1"] if ip != "127.0.0.1" else [])
    names = list(dns_names) + ["localhost"]
    want = "%s|%s|%s" % (",".join(ips), ",".join(names), ca_fingerprint(ca_crt))
    if valid_pair(crt, key) and os.path.exists(stamp):
        with open(stamp, encoding="utf-8") as f:
            have = f.read().strip().split("\n")
        # 만료 30일 전이면 새로 발급 (기록 파일이 깨졌으면 새로 발급)
        try:
            if have[0] == want and float(have[1]) - time.time() > 30 * 86400:
                return crt, key
        except (IndexError, ValueError):
            pass
    _need_openssl(openssl)
    san = ",".join(["IP:" + i for i in ips] + ["DNS:" + n for n in names])
    days = 397  # Apple 기기의 TLS 서버 인증서 유효기간 권장 상한(398일) 이내
    with tempfile.TemporaryDirectory(dir=CERT_DIR) as tmp:
        cnf = os.path.join(tmp, "req.cnf")
        ext = os.path.join(tmp, "server.ext")
        csr = os.path.join(tmp, "server.csr")
        _write(cnf, "[req]\ndistinguished_name = dn\nprompt = no\n[dn]\n" + SERVER_SUBJECT)
        tmp_key, tmp_crt = os.path.join(tmp, "server.key"), os.path.join(tmp, "server.crt")
        _write(ext, "basicConstraints = critical, CA:FALSE\n"
                    "keyUsage = critical, digitalSignature, keyEncipherment\n"
                    "extendedKeyUsage = serverAuth\n"
                    "subjectAltName = %s\n"
                    "subjectKeyIdentifier = hash\n"
                    "authorityKeyIdentifier = keyid, issuer\n" % san)
        old_umask = os.umask(0o077)
        try:
            _run(openssl, ["req", "-new", "-nodes", "-newkey", "rsa:2048", "-sha256", "-config", cnf,
                           "-keyout", tmp_key, "-out", csr])
            _run(openssl, ["x509", "-req", "-in", csr, "-CA", ca_crt, "-CAkey", ca_key,
                           "-set_serial", "0x" + os.urandom(16).hex(), "-sha256", "-days", str(days),
                           "-extfile", ext, "-out", tmp_crt])
        finally:
            os.umask(old_umask)
        install_pair(tmp_crt, tmp_key, crt, key)
    _write(stamp, "%s\n%f\n" % (want, time.time() + days * 86400))
    print("서버 인증서를 발급했습니다 (%s)" % san)
    return crt, key


def is_local_client(addr):
    """사설망·루프백·링크로컬 주소에서 온 요청만 허용."""
    try:
        a = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return a.is_private or a.is_loopback or a.is_link_local


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def send_head(self):
        if self.path.split("?", 1)[0] == CA_DOWNLOAD_PATH:
            return self.send_ca_cert()
        # 점(.)으로 시작하는 경로(.git, .cert 등)는 제공하지 않음
        parts = urllib.parse.unquote(self.path.split("?", 1)[0].split("#", 1)[0]).split("/")
        if any(p.startswith(".") for p in parts if p):
            self.send_error(404)
            return None
        return super().send_head()

    def send_ca_cert(self):
        """CA 공개 인증서만 DER로 내려준다 (iOS Safari는 이 형식을 '프로파일'로 받는다). 개인키는 제공하지 않음."""
        with open(os.path.join(CERT_DIR, "ca.crt"), encoding="ascii") as f:
            der = ssl.PEM_cert_to_DER_cert(f.read())
        self.send_response(200)
        self.send_header("Content-Type", "application/x-x509-ca-cert")
        self.send_header("Content-Length", str(len(der)))
        self.end_headers()
        return io.BytesIO(der)

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

    def verify_request(self, request, client_address):
        # 외부 인터넷 주소에서 온 연결은 받지 않음 (공유기 포트포워딩 등으로 노출돼도 차단)
        return is_local_client(client_address[0])

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
    openssl = find_openssl(args.openssl)
    ca_crt, ca_key = ensure_ca(openssl)
    local_name = mac_local_name()
    cert, key = ensure_server_cert(openssl, ca_crt, ca_key, ip, [local_name] if local_name else [])

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    httpd = TLSServer((args.bind, args.port), Handler, ctx)

    base = "https://%s:%d" % (ip, args.port)
    print()
    print("  ── iPhone (같은 Wi-Fi) ──────────────────────────────")
    print("  [처음 한 번] 인증서 설치:   %s%s" % (base, CA_DOWNLOAD_PATH))
    print("               (설치 방법은 pharmacy/README.md 참고)")
    print("  앱:                         %s/" % base)
    print("  기기 점검·테스트 바코드:     %s/test.html" % base)
    if local_name:
        print("  (IP 대신 이름으로도 접속:   https://%s:%d/)" % (local_name, args.port))
    print()
    print("  CA 인증서 SHA-256 지문 (iPhone 설치 화면의 '자세한 정보'와 같은지 확인):")
    print("    " + ca_fingerprint(ca_crt))
    print()
    print("  내부망(같은 Wi-Fi)에서만 접속됩니다. 테스트가 끝나면 Ctrl+C 또는 이 창을 닫아 종료하세요.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")


if __name__ == "__main__":
    main()
