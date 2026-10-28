"""Run one ledger/scheduler behind several explicitly configured private listeners."""
import argparse
import os
import signal
import threading
from http.server import ThreadingHTTPServer
from urllib.parse import urlsplit
from pocketquota.server import App, Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', default='.data')
    parser.add_argument('--origin', required=True, help='Public HTTPS origin used by the reverse proxy')
    parser.add_argument('--listen', action='append', help='Private IPv4 listener; repeat for multiple interfaces')
    parser.add_argument('--port', type=int, default=18790)
    args = parser.parse_args()
    origin = urlsplit(args.origin)
    if (origin.scheme != 'https' or not origin.hostname or origin.username or origin.password
            or origin.path not in ('', '/') or origin.query or origin.fragment):
        parser.error('--origin must be a clean HTTPS origin')
    args.origin = args.origin.rstrip('/')
    os.umask(0o077)
    app = App(args.data, args.port, origin=args.origin)
    servers = []
    running = []
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    try:
        # Bind all interfaces before starting any worker; a failed bind leaves none running.
        for host in dict.fromkeys(args.listen or ['127.0.0.1']):
            server = ThreadingHTTPServer((host, args.port), Handler)
            server.app = app
            servers.append(server)
        for server in servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            running.append(server)
        threading.Thread(target=app.scheduler, daemon=True).start()
        stopped.wait()
    finally:
        app.stop.set()
        for server in servers:
            if server in running:
                server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
