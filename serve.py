"""Local preview server for StrainWatch. Sends no-cache headers so edits show up on reload.

    .venv/Scripts/python strainwatch/serve.py          # then open http://localhost:8765
"""
import functools, http.server, os, sys

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (args[1] if len(args) > 1 else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    Handler.extensions_map.update({".js": "text/javascript", ".mjs": "text/javascript", ".bin": "application/octet-stream"})
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=SITE)) as srv:
        print(f"StrainWatch at http://localhost:{port}")
        srv.serve_forever()
