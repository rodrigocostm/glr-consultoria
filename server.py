#!/usr/bin/env python3
import http.server
import socketserver
import sys
import os

os.chdir(os.path.dirname(os.path.abspath(__file__)))

port = int(sys.argv[1]) if len(sys.argv) > 1 else 3200

Handler = http.server.SimpleHTTPRequestHandler
with socketserver.TCPServer(("", port), Handler) as httpd:
    print(f"GLR server on {port}")
    httpd.serve_forever()
