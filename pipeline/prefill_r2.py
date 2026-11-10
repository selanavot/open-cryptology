"""One-off (re-runnable) prefill of R2 with PDFs from existing public copies.

Streams each PDF in memory from its best known source (community GitHub mirror or Wayback
Machine `id_` capture) straight into the R2 bucket through Cloudflare's REST API, using
Wrangler's OAuth login. Nothing is written to disk except a small results log. Never fetches
from eprint.iacr.org.

Usage (from repo root):
  python3 -I pipeline/prefill_r2.py data/prefill/candidates.json data/prefill/results.jsonl

candidates.json = `wrangler d1 execute DB --remote --json --command "SELECT p.id, p.year, p.num,
p.title, p.updated, p.license_code, p.pdf_key, s.kind, s.url, s.captured_at, s.size FROM papers p
LEFT JOIN sources s ON s.paper_id = p.id WHERE p.withdrawn = 0"`.
Results are applied to D1 separately (apply_prefill.py) so D1's daily write quota isn't hit here.
"""

import hashlib
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ACCOUNT = "f1a5c2273555ad714cc5911124e671a7"
BUCKET = "open-cryptology-pdfs"
UA = "open-cryptology-prefill/0.1 (unofficial non-commercial ePrint mirror; copies public mirrors only)"
MAX_BYTES = 25 * 1024 * 1024
GITHUB_THREADS = 4
WAYBACK_GAP = 4.0  # seconds between Wayback fetches
WRANGLER_CFG = os.path.expanduser("~/Library/Preferences/.wrangler/config/default.toml")
WORKER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "worker")


class Token:
    """Wrangler's OAuth token, refreshed (via `wrangler whoami`) shortly before it expires."""

    def __init__(self):
        self.lock = threading.Lock()
        self._read()

    def _read(self):
        cfg = open(WRANGLER_CFG).read()
        self.value = re.search(r'^oauth_token\s*=\s*"([^"]+)"', cfg, re.M).group(1)
        exp = re.search(r'^expiration_time\s*=\s*"([^"]+)"', cfg, re.M).group(1)
        self.expires = time.mktime(time.strptime(exp[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone

    def get(self, force=False):
        with self.lock:
            if force or time.time() > self.expires - 300:
                subprocess.run(["npx", "--no-install", "wrangler", "whoami"], cwd=WORKER_DIR,
                               capture_output=True, timeout=120)
                self._read()
            return self.value


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        n = int(r.headers.get("Content-Length") or 0)
        if n > MAX_BYTES:
            raise ValueError(f"too large ({n} B)")
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("too large")
    if not data.startswith(b"%PDF-"):
        raise ValueError("not a PDF")
    return data


def put_r2(token, key, data):
    url = (f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects/"
           + urllib.parse.quote(key, safe=""))
    for attempt in range(4):
        req = urllib.request.Request(url, data=data, method="PUT", headers={
            "Authorization": f"Bearer {token.get(force=attempt > 0)}",
            "Content-Type": "application/pdf",
        })
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body = json.loads(r.read())
                if body.get("success"):
                    return
        except urllib.error.HTTPError as e:
            if e.code not in (401, 403, 429, 500, 502, 503, 504):
                raise
        time.sleep(2 ** attempt * 3)
    raise RuntimeError("R2 upload failed")


def rank(s, updated):
    fresh = bool(s["captured_at"] and updated and s["captured_at"] >= updated)
    return (2 if fresh else 0) + (1 if s["kind"] == "github-mirror" else 0)


def main(cand_path, out_path):
    rows = json.load(open(cand_path))[0]["results"]
    papers = {}
    for r in rows:
        p = papers.setdefault(r["id"], {"id": r["id"], "updated": r["updated"], "pdf_key": r["pdf_key"], "sources": []})
        if r["kind"] in ("github-mirror", "wayback") and r["url"]:
            p["sources"].append({"kind": r["kind"], "url": r["url"], "captured_at": r["captured_at"]})
    done = set()
    if os.path.exists(out_path):
        for line in open(out_path):
            j = json.loads(line)
            if j.get("ok"):
                done.add(j["id"])
    todo = [p for p in papers.values() if not p["pdf_key"] and p["id"] not in done and p["sources"]]
    for p in todo:
        p["sources"].sort(key=lambda s: (rank(s, p["updated"]), s["captured_at"] or ""), reverse=True)
    print(f"papers {len(papers)}; already mirrored {sum(1 for p in papers.values() if p['pdf_key'])}; "
          f"done earlier {len(done)}; to do {len(todo)}; no source {sum(1 for p in papers.values() if not p['sources'])}",
          flush=True)

    token = Token()
    qs = {"github-mirror": queue.Queue(), "wayback": queue.Queue()}
    for p in todo:
        qs[p["sources"][0]["kind"]].put((p, 0))
    out_lock = threading.Lock()
    out = open(out_path, "a")
    stats = {"ok": 0, "fail": 0, "bytes": 0}
    gh_pause_until = [0.0]
    pending = [len(todo)]

    def record(j):
        with out_lock:
            out.write(json.dumps(j) + "\n")
            out.flush()
            stats["ok" if j["ok"] else "fail"] += 1
            stats["bytes"] += j.get("size", 0)
            n = stats["ok"] + stats["fail"]
            if n % 200 == 0:
                print(f"{time.strftime('%H:%M:%S')} progress {n}/{len(todo)} ok={stats['ok']} fail={stats['fail']} "
                      f"{stats['bytes'] / 1e9:.2f} GB", flush=True)

    def handle(p, idx):
        s = p["sources"][idx]
        try:
            data = fetch(s["url"])
            sha = hashlib.sha256(data).hexdigest()
            put_r2(token, f"pdf/{p['id']}.pdf", data)
            stale = 1 if (s["captured_at"] and p["updated"] and s["captured_at"] < p["updated"]) else 0
            record({"id": p["id"], "ok": True, "source": s["kind"], "url": s["url"], "captured_at": s["captured_at"],
                    "size": len(data), "sha256": sha, "stale": stale})
            return True
        except Exception as e:  # noqa: BLE001 - record and move on
            err = f"{type(e).__name__}: {e}"[:200]
            if isinstance(e, urllib.error.HTTPError) and e.code == 429 and s["kind"] == "github-mirror":
                gh_pause_until[0] = time.time() + 120
            if idx + 1 < len(p["sources"]):
                qs[p["sources"][idx + 1]["kind"]].put((p, idx + 1))
                return None  # retried on the next source
            record({"id": p["id"], "ok": False, "source": s["kind"], "url": s["url"], "error": err})
            return False

    def worker(kind):
        q = qs[kind]
        while True:
            try:
                p, idx = q.get(timeout=5)
            except queue.Empty:
                if pending[0] <= 0:
                    return
                continue
            if kind == "github-mirror":
                while time.time() < gh_pause_until[0]:
                    time.sleep(5)
            r = handle(p, idx)
            if r is not None:
                with out_lock:
                    pending[0] -= 1
            if kind == "wayback":
                time.sleep(WAYBACK_GAP)

    threads = [threading.Thread(target=worker, args=("github-mirror",)) for _ in range(GITHUB_THREADS)]
    threads.append(threading.Thread(target=worker, args=("wayback",)))
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    print(f"done: ok={stats['ok']} fail={stats['fail']} {stats['bytes'] / 1e9:.2f} GB", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
