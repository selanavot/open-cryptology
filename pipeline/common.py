"""Shared helpers for the ePrint mirror pipeline (Python 3 stdlib only).

- polite HTTP GET with per-host minimum spacing and backoff on 429/5xx/connection errors
- SQL literal quoting for generated D1 files
- thin wrappers around `wrangler d1 execute` / `wrangler r2 object put|get` (local by default)
"""

import json
import os
import random
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER_DIR = os.path.join(REPO, "worker")
DATA_DIR = os.path.join(REPO, "data")  # gitignored scratch space for generated SQL / temp files

USER_AGENT = (
    "eprint-mirror-pipeline/0.1 (unofficial non-commercial ePrint mirror; "
    "polite metadata/source discovery)"
)

D1_BINDING = "DB"
R2_BUCKET = "eprint-pdfs"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- HTTP

_last_request = {}  # host -> monotonic time of last request start


class FetchError(Exception):
    pass


def polite_get(url, min_interval=1.0, max_tries=8, base_backoff=5.0, max_backoff=300.0,
               timeout=120, headers=None, stream_to=None, max_bytes=None, fatal_status=()):
    """GET `url`, sleeping so requests to the same host are >= min_interval s apart.

    Retries with exponential backoff (+ jitter, honouring Retry-After) on 429, 5xx and
    connection errors, except statuses in `fatal_status`, which raise FetchError at once
    (no retry). Returns bytes, or (if stream_to is a path) writes the body there and
    returns the number of bytes written. Raises FetchError on 4xx (other than 429) or after
    max_tries.
    """
    host = urllib.parse.urlsplit(url).netloc
    hdrs = {"User-Agent": USER_AGENT}
    hdrs.update(headers or {})
    delay = base_backoff
    for attempt in range(1, max_tries + 1):
        wait = _last_request.get(host, 0) + min_interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_request[host] = time.monotonic()
        retry_after = None
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if stream_to is None:
                    body = resp.read(max_bytes + 1 if max_bytes else -1)
                    if max_bytes and len(body) > max_bytes:
                        raise FetchError(f"response larger than {max_bytes} bytes: {url}")
                    return body
                n = 0
                with open(stream_to, "wb") as f:
                    while True:
                        chunk = resp.read(1 << 16)
                        if not chunk:
                            break
                        n += len(chunk)
                        if max_bytes and n > max_bytes:
                            raise FetchError(f"response larger than {max_bytes} bytes: {url}")
                        f.write(chunk)
                return n
        except urllib.error.HTTPError as e:
            if e.code in fatal_status or (e.code != 429 and e.code < 500):
                raise FetchError(f"HTTP {e.code} for {url}") from e
            ra = e.headers.get("Retry-After") if e.headers else None
            if ra and ra.isdigit():
                retry_after = int(ra)
            why = f"HTTP {e.code}"
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
            why = f"{type(e).__name__}: {getattr(e, 'reason', e)}"
        if attempt == max_tries:
            raise FetchError(f"giving up on {url} after {max_tries} tries ({why})")
        sleep = retry_after if retry_after is not None else delay * (1 + random.random() * 0.25)
        sleep = min(sleep, max_backoff)
        log(f"  [{host}] {why}; retry {attempt}/{max_tries - 1} in {sleep:.0f}s")
        time.sleep(sleep)
        delay = min(delay * 2, max_backoff)
        _last_request[host] = time.monotonic()


# --------------------------------------------------------------------------- SQL

def sql_lit(v):
    """Render a Python value as a SQLite literal."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return repr(v)
    s = str(v).replace("\x00", "")
    return "'" + s.replace("'", "''") + "'"


def _wrangler(args, capture=True):
    cmd = ["npx", "--no-install", "wrangler"] + args
    r = subprocess.run(cmd, cwd=WORKER_DIR, capture_output=capture, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"wrangler failed ({' '.join(args[:3])}...):\n{r.stdout}\n{r.stderr}")
    return r.stdout


def d1_exec_file(path, remote=False):
    _wrangler(["d1", "execute", D1_BINDING, "--remote" if remote else "--local",
               "--yes", "--file", os.path.abspath(path)])


def d1_exec_statements(statements, name, chunk=500, remote=False, keep=False):
    """Write statements to data/<name>-NNN.sql in chunks and execute each file; delete after."""
    os.makedirs(DATA_DIR, exist_ok=True)
    total = len(statements)
    for i in range(0, total, chunk):
        path = os.path.join(DATA_DIR, f"{name}-{i // chunk:03d}.sql")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(statements[i:i + chunk]))
            f.write("\n")
        d1_exec_file(path, remote=remote)
        if not keep:
            os.remove(path)
        log(f"  {name}: {min(i + chunk, total)}/{total} statements applied")


def d1_query(sql, remote=False):
    """Run a read query; returns list of dict rows (results of the last statement)."""
    out = _wrangler(["d1", "execute", D1_BINDING, "--remote" if remote else "--local",
                     "--json", "--command", sql])
    data = json.loads(out)
    return data[-1]["results"] if data else []


def r2_put(key, path, content_type="application/pdf", remote=False):
    _wrangler(["r2", "object", "put", f"{R2_BUCKET}/{key}", "--remote" if remote else "--local",
               "--file", os.path.abspath(path), "--content-type", content_type])


def r2_get(key, path, remote=False):
    _wrangler(["r2", "object", "get", f"{R2_BUCKET}/{key}", "--remote" if remote else "--local",
               "--file", os.path.abspath(path)])
