#!/usr/bin/env python3
"""Version history backfill: find every distinct PDF of every paper (without downloading to the
laptop) and copy the ones we don't hold yet into R2 via the temporary helper Worker
`open-cryptology-versions` (versions-worker/). Writes D1 `versions` (remote). See docs/VERSIONS.md.

Stages (each resumable; state lives in data/versions/, gitignored):

  list      Wayback CDX listing of eprint.iacr.org/YYYY/NNNN.pdf captures (prefix + pagination
            API, same as discover_sources.py, ~170 pages, >= 5 s apart, cached per page)
            -> data/versions/cdx-rows.json. Fields: original,timestamp,length,mimetype,status,digest.
  existing  Hash the PDFs already in R2 at the legacy key pdf/<id>.pdf (in Cloudflare, /hash) and
            record each as a version (source/url/captured_at from papers.pdf_* or the prefill
            results). Also fills papers.pdf_sha256 where it is NULL.
  plan      Per paper: distinct Wayback digests (SHA-1 of the payload) among 200 application/pdf
            captures, each dated by its EARLIEST capture, plus the GitHub-mirror snapshot.
            Anything whose digest is already held is dropped -> data/versions/plan.json.
  copy      Run the plan through /copy: GitHub items in parallel batches, Wayback one item at a
            time >= 3 s apart, backing off on 429/503/refused connections. The Worker skips
            content we already hold (sha256), so duplicates cost a download but no storage.
            -> data/versions/copy-results.jsonl
  apply     Insert `versions` rows for stored copies; point papers.pdf_key at the latest version
            when a newer one was found or none was set (e.g. withdrawn papers).
  stats     Counts.

  python3 -I pipeline/discover_versions.py list
  python3 -I pipeline/discover_versions.py existing [--prefill-results PATH]
  python3 -I pipeline/discover_versions.py plan
  python3 -I pipeline/discover_versions.py copy [--limit N]
  python3 -I pipeline/discover_versions.py apply
  python3 -I pipeline/discover_versions.py stats
"""

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA_DIR, d1_exec_statements, d1_query, log, sql_lit  # noqa: E402

os.environ.setdefault("CLOUDFLARE_ACCOUNT_ID", "f1a5c2273555ad714cc5911124e671a7")  # wrangler --remote
HELPER = os.environ.get("VERSIONS_HELPER", "https://open-cryptology-versions.opencryptology.workers.dev")
VDIR = os.path.join(DATA_DIR, "versions")
KEY_FILE = os.path.join(VDIR, ".versions-key")
CDX_ROWS = os.path.join(VDIR, "cdx-rows.json")
PLAN = os.path.join(VDIR, "plan.json")
EXISTING = os.path.join(VDIR, "existing-results.jsonl")
COPY = os.path.join(VDIR, "copy-results.jsonl")
PDF_RE = re.compile(r"^https?://(?:www\.)?eprint\.iacr\.org(?::\d+)?/(\d{4})/(\d{3,5})\.pdf$")
MAX_SIZE = 50 * 1024 * 1024
WB_GAP = 3.0
UA = "open-cryptology-versions-driver/0.1 (unofficial non-commercial ePrint mirror)"


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def stamp_of(iso):
    """'2024-03-02T12:34:56Z' (or a Wayback 14-digit timestamp) -> '20240302T123456Z'."""
    if re.fullmatch(r"\d{14}", iso):
        return f"{iso[:8]}T{iso[8:]}Z"
    d = re.sub(r"[^0-9]", "", iso)[:14].ljust(14, "0")
    return f"{d[:8]}T{d[8:]}Z"


def ts_iso(ts):
    return f"{ts[0:4]}-{ts[4:6]}-{ts[6:8]}T{ts[8:10]}:{ts[10:12]}:{ts[12:14]}Z"


def remote(sql):
    return d1_query(sql, remote=True)


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


class Throttled(Exception):
    pass


def helper(path, items, timeout=300):
    req = urllib.request.Request(f"{HELPER}{path}", data=json.dumps(items).encode(), method="POST", headers={
        "x-versions-key": open(KEY_FILE).read().strip(), "content-type": "application/json", "user-agent": UA})
    err = None
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(5 * 2 ** attempt)
    return [{"id": it["id"], "key": it.get("key"), "ok": False, "error": f"helper call failed: {err}"} for it in items]


# --------------------------------------------------------------------------- list

def cmd_list(_a):
    import discover_sources as ds  # reuses its paged CDX listing + per-page cache under data/cache/discover
    rows = ds.cdx_captures()
    os.makedirs(VDIR, exist_ok=True)
    with open(CDX_ROWS + ".tmp", "w") as f:
        json.dump(rows, f)
    os.replace(CDX_ROWS + ".tmp", CDX_ROWS)
    log(f"{len(rows)} captures -> {CDX_ROWS}")


# --------------------------------------------------------------------------- existing

def cmd_existing(a):
    papers = remote("SELECT p.id, p.pdf_key, p.pdf_source, p.pdf_source_date, p.pdf_sha256, "
                    "(SELECT url FROM sources s WHERE s.paper_id = p.id AND s.kind = p.pdf_source) AS src_url "
                    "FROM papers p")
    have = {r["r2_key"] for r in remote("SELECT r2_key FROM versions")}
    prefill = {}
    if a.prefill_results and os.path.exists(a.prefill_results):
        for j in read_jsonl(a.prefill_results):
            if j.get("ok"):
                prefill[j["id"]] = j
    done = {j["key"] for j in read_jsonl(EXISTING)}
    # Only papers that plausibly have an object at the legacy key: pdf_key set, or prefilled.
    todo = [p for p in papers
            if (p["pdf_key"] or p["id"] in prefill)
            and f"pdf/{p['id']}.pdf" not in have and f"pdf/{p['id']}.pdf" not in done]
    log(f"hashing {len(todo)} legacy objects in R2 via helper")
    lock = threading.Lock()
    out = open(EXISTING, "a", encoding="utf-8")
    cnt = [0]

    def run(batch):
        res = helper("/hash", [{"id": p["id"], "key": f"pdf/{p['id']}.pdf"} for p in batch])
        by = {r["id"]: r for r in res}
        with lock:
            for p in batch:
                r = by.get(p["id"], {"ok": False, "error": "no result"})
                pf = prefill.get(p["id"], {})
                src = p["pdf_source"] or pf.get("source") or "other"
                rec = {"id": p["id"], "key": f"pdf/{p['id']}.pdf", **{k: r.get(k) for k in ("ok", "error", "sha256", "sha1", "size")},
                       "source": src,
                       "source_url": p["src_url"] if p["pdf_source"] else pf.get("url"),
                       "captured_at": p["pdf_source_date"] or pf.get("captured_at")}
                out.write(json.dumps(rec) + "\n")
                cnt[0] += 1
            out.flush()
            if cnt[0] % 1000 < len(batch):
                log(f"  {time.strftime('%H:%M:%S')} {cnt[0]}/{len(todo)}")

    with ThreadPoolExecutor(6) as ex:
        list(ex.map(run, [todo[i:i + 20] for i in range(0, len(todo), 20)]))
    out.close()
    write_existing()


def write_existing():
    recs = [j for j in read_jsonl(EXISTING) if j.get("ok")]
    stmts = []
    for j in recs:
        cap = j["captured_at"] or now_iso()
        stmts.append(
            "INSERT OR IGNORE INTO versions (paper_id, stamp, r2_key, sha256, sha1, size, source, source_url, captured_at, added_at) "
            f"VALUES ({sql_lit(j['id'])}, {sql_lit(stamp_of(cap))}, {sql_lit(j['key'])}, {sql_lit(j['sha256'])}, "
            f"{sql_lit(j['sha1'])}, {sql_lit(j['size'])}, {sql_lit(j['source'])}, {sql_lit(j['source_url'])}, "
            f"{sql_lit(cap)}, {sql_lit(now_iso())});")
        stmts.append(f"UPDATE papers SET pdf_sha256 = {sql_lit(j['sha256'])} WHERE id = {sql_lit(j['id'])} "
                     f"AND pdf_key = {sql_lit(j['key'])} AND pdf_sha256 IS NULL;")
    log(f"recording {len(recs)} legacy objects as versions")
    d1_exec_statements(stmts, "versions-existing", chunk=2000, remote=True)


# --------------------------------------------------------------------------- plan

def cmd_plan(_a):
    rows = json.load(open(CDX_ROWS))
    papers = {(r["year"], r["num"]): r["id"] for r in remote("SELECT id, year, num FROM papers")}
    held = {}
    for v in remote("SELECT paper_id, sha1, sha256, source FROM versions"):
        h = held.setdefault(v["paper_id"], {"sha1": set(), "sha256": set(), "sources": set()})
        if v["sha1"]:
            h["sha1"].add(v["sha1"])
        if v["sha256"]:
            h["sha256"].add(v["sha256"])
        h["sources"].add(v["source"])
    for j in read_jsonl(COPY):  # content already copied (or found to be a duplicate) in earlier runs
        if j.get("ok") and j.get("sha1"):
            h = held.setdefault(j["id"], {"sha1": set(), "sha256": set(), "sources": set()})
            h["sha1"].add(j["sha1"])
            h["sha256"].add(j["sha256"])
            if j.get("digest"):
                h["sha1"].add(j["digest"])
    gh = {r["paper_id"]: r for r in remote("SELECT paper_id, url, captured_at, size FROM sources WHERE kind = 'github-mirror'")}

    # Distinct digests per paper, each with its earliest 200-PDF capture.
    per = {}
    for original, ts, length, mime, status, digest in rows:
        m = PDF_RE.match(original)
        if not m or mime != "application/pdf" or status != "200":
            continue
        pid = papers.get((int(m.group(1)), int(m.group(2))))
        if not pid:
            continue
        d = per.setdefault(pid, {})
        size = int(length) if length.isdigit() else None
        if digest not in d or ts < d[digest][0]:
            d[digest] = (ts, original, size)
    copied_keys = {j["key"] for j in read_jsonl(COPY) if j.get("ok") or "rejected" in str(j.get("error"))}
    plan = []
    for pid, digests in per.items():
        h = held.get(pid, {"sha1": set(), "sha256": set(), "sources": set()})
        for digest, (ts, orig, size) in digests.items():
            if digest in h["sha1"] or (size and size > MAX_SIZE):
                continue
            key = f"pdf/{pid}/{stamp_of(ts)}.pdf"
            if key in copied_keys:
                continue
            plan.append({"id": pid, "kind": "wayback", "url": f"https://web.archive.org/web/{ts}id_/{orig}",
                         "captured_at": ts_iso(ts), "key": key, "digest": digest, "size": size})
    for pid, s in gh.items():
        h = held.get(pid, {"sources": set()})
        if "github-mirror" in h["sources"] or not s["captured_at"]:
            continue
        key = f"pdf/{pid}/{stamp_of(s['captured_at'])}.pdf"
        if key in copied_keys:
            continue
        plan.append({"id": pid, "kind": "github-mirror", "url": s["url"], "captured_at": s["captured_at"],
                     "key": key, "digest": None, "size": s["size"]})
    with open(PLAN, "w") as f:
        json.dump(plan, f)
    wb = [p for p in plan if p["kind"] == "wayback"]
    log(f"papers with Wayback PDF captures: {len(per)}; distinct digests: {sum(len(d) for d in per.values())}")
    log(f"plan: {len(plan)} copies ({len(wb)} wayback for {len({p['id'] for p in wb})} papers, "
        f"{len(plan) - len(wb)} github), ~{sum(p['size'] or 0 for p in plan) / 1e9:.1f} GB before dedup")


# --------------------------------------------------------------------------- copy

def cmd_copy(a):
    plan = json.load(open(PLAN))
    done = {j["key"] for j in read_jsonl(COPY) if j.get("ok") or j.get("final")}
    todo = [p for p in plan if p["key"] not in done]
    if a.kind:
        todo = [p for p in todo if p["kind"] == a.kind]
    if a.limit:
        todo = todo[:a.limit]
    # sha256 of content we hold per paper (the Worker skips these)
    known = {}
    for v in remote("SELECT paper_id, sha256 FROM versions WHERE sha256 IS NOT NULL"):
        known.setdefault(v["paper_id"], set()).add(v["sha256"])
    for j in read_jsonl(COPY):
        if j.get("ok") and j.get("sha256"):
            known.setdefault(j["id"], set()).add(j["sha256"])
    gh = [p for p in todo if p["kind"] == "github-mirror"]
    wb = [p for p in todo if p["kind"] == "wayback"]
    log(f"copy: {len(gh)} github + {len(wb)} wayback items to do")
    lock = threading.Lock()
    out = open(COPY, "a", encoding="utf-8")
    st = {"stored": 0, "dup": 0, "fail": 0, "bytes": 0, "n": 0, "t0": time.time()}

    def record(p, r, final=True):
        rec = {**{k: p[k] for k in ("id", "kind", "url", "captured_at", "key", "digest")},
               **{k: r.get(k) for k in ("ok", "stored", "dup", "sha256", "sha1", "size", "status", "error")},
               "final": final}
        with lock:
            out.write(json.dumps(rec) + "\n")
            out.flush()
            if r.get("ok"):
                known.setdefault(p["id"], set()).add(r["sha256"])
                st["stored" if r.get("stored") else "dup"] += 1
                st["bytes"] += r.get("size", 0) if r.get("stored") else 0
            else:
                st["fail"] += 1
            st["n"] += 1
            if st["n"] % 200 == 0:
                el = time.time() - st["t0"]
                log(f"  {time.strftime('%H:%M:%S')} {st['n']}/{len(todo)} stored={st['stored']} dup={st['dup']} "
                    f"fail={st['fail']} {st['bytes'] / 1e9:.2f} GB ({st['n'] / el * 60:.0f}/min)")

    def gh_batch(batch):
        res = helper("/copy", [{"id": p["id"], "url": p["url"], "key": p["key"],
                                "skip": sorted(known.get(p["id"], ()))} for p in batch])
        by = {r["key"]: r for r in res}
        for p in batch:
            record(p, by.get(p["key"], {"ok": False, "error": "no result"}))

    def gh_all():
        with ThreadPoolExecutor(4) as ex:
            list(ex.map(gh_batch, [gh[i:i + 10] for i in range(0, len(gh), 10)]))

    def wb_all():
        backoff = 60
        last = 0.0
        i = 0
        while i < len(wb):
            p = wb[i]
            wait = last + WB_GAP - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            last = time.monotonic()
            r = helper("/copy", [{"id": p["id"], "url": p["url"], "key": p["key"],
                                  "skip": sorted(known.get(p["id"], ()))}])[0]
            transient = not r.get("ok") and (r.get("status") in (429, 502, 503, 504) or
                                             (r.get("status") is None and "rejected" not in str(r.get("error"))
                                              and "not a PDF" not in str(r.get("error"))
                                              and "too large" not in str(r.get("error"))))
            if transient:
                log(f"  wayback throttling/error ({r.get('status') or r.get('error')}) on {p['id']}; backing off {backoff}s")
                time.sleep(backoff)
                backoff = min(backoff * 2, 1800)
                if backoff >= 1800:
                    record(p, r, final=False)  # give up on this one for now; a later run retries it
                    i += 1
                    backoff = 600
                continue
            backoff = 60
            record(p, r)
            i += 1

    threads = [threading.Thread(target=gh_all), threading.Thread(target=wb_all)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    out.close()
    log(f"done: stored={st['stored']} dup={st['dup']} fail={st['fail']} {st['bytes'] / 1e9:.2f} GB")


# --------------------------------------------------------------------------- apply

def cmd_apply(_a):
    recs = [j for j in read_jsonl(COPY) if j.get("ok") and j.get("stored")]
    stmts = []
    for j in recs:
        stmts.append(
            "INSERT OR IGNORE INTO versions (paper_id, stamp, r2_key, sha256, sha1, size, source, source_url, captured_at, added_at) "
            f"VALUES ({sql_lit(j['id'])}, {sql_lit(stamp_of(j['captured_at']))}, {sql_lit(j['key'])}, {sql_lit(j['sha256'])}, "
            f"{sql_lit(j['sha1'])}, {sql_lit(j['size'])}, {sql_lit(j['kind'])}, {sql_lit(j['url'])}, "
            f"{sql_lit(j['captured_at'])}, {sql_lit(now_iso())});")
    # Point papers.pdf_key at the newest version when it is newer than what pdf_key holds (or
    # nothing is set, e.g. withdrawn papers). pdf_maybe_stale follows the OAI datestamp rule
    # (not for withdrawn papers: their datestamp is the withdrawal).
    stmts.append("""
UPDATE papers SET
  pdf_key = v.r2_key, pdf_sha256 = v.sha256, pdf_size = v.size, pdf_source = v.source,
  pdf_source_date = v.captured_at,
  pdf_maybe_stale = CASE WHEN papers.withdrawn = 0 AND papers.updated IS NOT NULL AND v.captured_at < papers.updated
                         THEN 1 ELSE 0 END
FROM (SELECT paper_id, r2_key, sha256, size, source, captured_at,
             row_number() OVER (PARTITION BY paper_id ORDER BY captured_at DESC, id DESC) AS rn
        FROM versions) AS v
WHERE v.paper_id = papers.id AND v.rn = 1 AND v.r2_key IS NOT papers.pdf_key
  AND (papers.pdf_key IS NULL OR papers.pdf_source_date IS NULL OR v.captured_at > papers.pdf_source_date);""")
    log(f"recording {len(recs)} copied versions")
    d1_exec_statements(stmts, "versions-apply", chunk=2000, remote=True)
    cmd_stats(None)


def cmd_stats(_a):
    r = remote("""SELECT count(*) AS versions, count(DISTINCT paper_id) AS papers, sum(size) AS bytes,
                  sum(r2_key NOT GLOB 'pdf/*/*/*') AS legacy, sum(source='wayback') AS wayback,
                  sum(source='github-mirror') AS github FROM versions""")[0]
    multi = remote("SELECT count(*) AS n FROM (SELECT paper_id FROM versions GROUP BY paper_id HAVING count(*) >= 2)")[0]["n"]
    added = remote("SELECT count(*) AS n, sum(size) AS bytes FROM versions WHERE r2_key GLOB 'pdf/*/*/*'")[0]
    wd = remote("SELECT count(*) AS n, sum(pdf_key IS NOT NULL) AS pdf FROM papers WHERE withdrawn = 1")[0]
    print(json.dumps({**r, "papers_with_2plus_versions": multi, "new_version_objects": added["n"],
                      "new_version_gb": round((added["bytes"] or 0) / 1e9, 2),
                      "withdrawn_papers": wd["n"], "withdrawn_with_pdf": wd["pdf"]}, indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", choices=["list", "existing", "plan", "copy", "apply", "stats"])
    ap.add_argument("--prefill-results", default=os.path.join(DATA_DIR, "prefill", "results.jsonl"),
                    help="prefill_via_worker.py results (source/url/date for objects whose D1 row isn't updated yet)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--kind", choices=["wayback", "github-mirror"])
    a = ap.parse_args()
    os.makedirs(VDIR, exist_ok=True)
    {"list": cmd_list, "existing": cmd_existing, "plan": cmd_plan, "copy": cmd_copy,
     "apply": cmd_apply, "stats": cmd_stats}[a.stage](a)


if __name__ == "__main__":
    main()
