"""Tiny dual-stack static server for the Closwiz landing.

Binds :: with IPV6_V6ONLY=0 so BOTH localhost (IPv6 ::1) and 127.0.0.1 work
in Chrome (this box resolves localhost -> ::1).

The landing's CTAs link to /signup and /login (kept as-is per spec). Those are
APP routes, not files in this folder — in production the landing + app share a
domain (or signup lives at app.closwiz.com). For LOCAL preview the dashboard
SPA runs on :2886 and owns those routes, so we 302 them over instead of 404ing.
"""
import http.server, socketserver, socket, functools

PORT = 2887
DIR = r"C:\Users\lenovo\Desktop\leadecombot\closwiz-landing"
APP_ORIGIN = "http://localhost:2886"          # the running dashboard SPA
APP_ROUTES = ("/signup", "/login")


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        if path in APP_ROUTES:
            self.send_response(302)
            self.send_header("Location", APP_ORIGIN + self.path)
            self.end_headers()
            return
        super().do_GET()


class DualStackServer(socketserver.TCPServer):
    address_family = socket.AF_INET6
    allow_reuse_address = True

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        super().server_bind()


handler = functools.partial(Handler, directory=DIR)
with DualStackServer(("::", PORT), handler) as httpd:
    print(f"Closwiz landing on http://localhost:{PORT}/  (/signup,/login -> {APP_ORIGIN})")
    httpd.serve_forever()
