import http.server, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3200
DIRECTORY = "/Users/macbook/Documents/glr-consultoria"

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)
    def log_message(self, format, *args):
        print(format % args, flush=True)

with http.server.HTTPServer(("", PORT), Handler) as httpd:
    print(f"Serving GLR Consultoria on port {PORT}", flush=True)
    httpd.serve_forever()
