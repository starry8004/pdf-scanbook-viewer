"""PDF 스캔북 뷰어 로컬 서버.

127.0.0.1:8765 에서 뷰어를 띄우고 브라우저를 엽니다.
포트를 바꾸면 브라우저 저장소(읽던 쪽, 연결한 폴더)가 초기화되므로 고정해 둡니다.
"""
import functools
import http.server
import os
import sys
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 8765
URL = f"http://127.0.0.1:{PORT}/"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".css": "text/css",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


def already_running() -> bool:
    try:
        with urllib.request.urlopen(URL + "index.html", timeout=2) as r:
            return b"pdf-scanbook-viewer" in r.read()
    except Exception:
        return False


def main():
    try:
        srv = http.server.ThreadingHTTPServer(
            ("127.0.0.1", PORT), functools.partial(Handler, directory=ROOT)
        )
    except OSError:
        if already_running():
            webbrowser.open(URL)
            return
        print(f"포트 {PORT} 를 다른 프로그램이 사용 중입니다.")
        sys.exit(1)

    print(f"PDF 스캔북 뷰어: {URL}")
    print("이 창을 닫으면 뷰어 서버가 종료됩니다.")
    if "--no-browser" not in sys.argv:
        webbrowser.open(URL)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
