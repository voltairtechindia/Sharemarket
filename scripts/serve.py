"""Run the whole thing on your own machine.

    python scripts/serve.py

Two reasons to use this instead of GitHub Pages: the refresh loop can be much
faster than the 5 minute Actions floor, and NSE's own endpoints answer a home
broadband IP while they block datacenter IPs. Open http://<your-lan-ip>:8000
from any device on the same network.
"""
import argparse
import functools
import http.server
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable


def run(script):
    try:
        subprocess.run([PY, str(ROOT / "scripts" / script)], cwd=ROOT, check=False, timeout=300)
    except subprocess.TimeoutExpired:
        print(f"{script} timed out, will try again next cycle")


def loop(script, seconds):
    while True:
        print(f"\n--- {script} {time.strftime('%H:%M:%S')} ---")
        run(script)
        time.sleep(seconds)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:  # noqa: BLE001
        return "127.0.0.1"
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--market-every", type=int, default=60, help="seconds")
    ap.add_argument("--news-every", type=int, default=300, help="seconds")
    args = ap.parse_args()

    threading.Thread(target=loop, args=("fetch_market.py", args.market_every), daemon=True).start()
    threading.Thread(target=loop, args=("fetch_news.py", args.news_every), daemon=True).start()
    threading.Thread(target=loop, args=("fetch_flows.py", args.news_every), daemon=True).start()

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), handler)
    print(f"\nDashboard on http://{lan_ip()}:{args.port}  (and http://localhost:{args.port})")
    print("Ctrl-C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
