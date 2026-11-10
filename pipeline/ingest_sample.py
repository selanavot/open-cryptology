#!/usr/bin/env python3
"""Ingest a small, spread-out sample of PDFs (~20) into local R2 and record them in D1.

For each chosen paper: pick the best known source (from `sources`), stream it to a temp file
under data/tmp/, check the %PDF magic and size (< 20 MB), compute sha256, put it into R2 at
pdf/YYYY/NNNN.pdf, set papers.pdf_* columns, delete the temp file. Never contacts
eprint.iacr.org.

Selection is deterministic and idempotent: papers that already have a pdf_key count towards the
sample and are not re-downloaded (unless --force). Requirements covered: every license code
(incl. CC BY-NC-ND and CC0), pre-2010 papers, 2026 papers, and the rest spread across years.

Source preference: a source captured at/after the paper's OAI `updated` datestamp ("fresh")
beats a stale one; among fresh sources the GitHub mirror (fast, not throttled) beats Wayback;
among stale ones the most recent capture wins. If a download fails or is not a PDF, the next source is tried.

Usage (from repo root):
  python3 -I pipeline/ingest_sample.py               # top up to 20 sample papers
  python3 -I pipeline/ingest_sample.py -n 25
  python3 -I pipeline/ingest_sample.py --ids 2024/123,1999/001 [--force]
  python3 -I pipeline/ingest_sample.py --dry-run     # show choices only
"""

import argparse
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (DATA_DIR, FetchError, d1_exec_statements, d1_query, log,  # noqa: E402
                    polite_get, r2_put, sql_lit)

MAX_BYTES = 20 * 1024 * 1024
LICENSES = ["CC BY-NC-ND", "CC0", "CC BY-SA", "CC BY-NC", "CC BY-NC-SA", "CC BY"]
HOST_INTERVAL = {"github-mirror": 1.0, "wayback": 5.0}


def h(s):
    return hashlib.sha1(s.encode()).hexdigest()


def load_candidates():
    rows = d1_query(
        "SELECT p.id, p.year, p.num, p.license_code, p.updated, p.pdf_key, "
        "s.kind, s.url, s.captured_at, s.size "
        "FROM papers p JOIN sources s ON s.paper_id = p.id "
        "WHERE p.withdrawn = 0 AND (s.size IS NULL OR s.size < 20971520)")
    papers = {}
    for r in rows:
        p = papers.setdefault(r["id"], {k: r[k] for k in
                                        ("id", "year", "num", "license_code", "updated", "pdf_key")})
        p.setdefault("sources", []).append({k: r[k] for k in ("kind", "url", "captured_at", "size")})
    return papers


def rank_sources(p):
    def key(s):
        fresh = bool(s["captured_at"] and p["updated"] and s["captured_at"] >= p["updated"])
        # fresh: GitHub first (fast, unthrottled); stale: newest capture first, whatever the host
        return (not fresh, fresh and s["kind"] != "github-mirror", "~" if not s["captured_at"] else
                "".join(chr(255 - ord(ch)) for ch in s["captured_at"]))  # newest first
    return sorted(p["sources"], key=key)


def choose(papers, n):
    chosen = [pid for pid, p in sorted(papers.items()) if p["pdf_key"]]
    pool = sorted(papers.values(), key=lambda p: h(p["id"]))

    def take(pred, k=1):
        for p in pool:
            if k <= 0 or len(chosen) >= n:
                return
            if p["id"] not in chosen and pred(p):
                chosen.append(p["id"])
                k -= 1

    def have(pred):
        return sum(1 for i in chosen if pred(papers[i]))

    for lic in LICENSES:
        if not have(lambda p, lic=lic: p["license_code"] == lic):
            take(lambda p, lic=lic: p["license_code"] == lic and 2010 <= p["year"] <= 2025)
    take(lambda p: p["year"] < 2000, 1 - have(lambda p: p["year"] < 2000))
    take(lambda p: p["year"] < 2010, 2 - have(lambda p: p["year"] < 2010))
    take(lambda p: p["year"] == 2026, 2 - have(lambda p: p["year"] == 2026))
    # Exercise both source kinds and the staleness flag.
    take(lambda p: {s["kind"] for s in p["sources"]} == {"wayback"},
         1 - have(lambda p: {s["kind"] for s in p["sources"]} == {"wayback"}))
    all_stale = lambda p: not any(s["captured_at"] and p["updated"] and  # noqa: E731
                                  s["captured_at"] >= p["updated"] for s in p["sources"])
    take(all_stale, 1 - have(all_stale))
    # Fill with one paper per not-yet-covered year, walking years in a spread-out order.
    years = sorted({p["year"] for p in papers.values()})
    order = years[::3] + years[1::3] + years[2::3]
    for y in order:
        if len(chosen) >= n:
            break
        if not have(lambda p, y=y: p["year"] == y):
            take(lambda p, y=y: p["year"] == y)
    take(lambda p: True, n - len(chosen))
    return chosen[:max(n, len(chosen))]


def ingest(p, dry_run=False):
    tmpdir = os.path.join(DATA_DIR, "tmp")
    os.makedirs(tmpdir, exist_ok=True)
    tmp = os.path.join(tmpdir, p["id"].replace("/", "-") + ".pdf.part")
    key = f"pdf/{p['id']}.pdf"
    for s in rank_sources(p):
        stale = 0 if (s["captured_at"] and p["updated"] and s["captured_at"] >= p["updated"]) else 1
        if dry_run:
            log(f"  {p['id']:>10} {p['license_code']:<12} {s['kind']:<13} {s['captured_at']} "
                f"stale={stale}  {s['url']}")
            return True
        try:
            size = polite_get(s["url"], min_interval=HOST_INTERVAL.get(s["kind"], 2.0),
                              max_tries=5, stream_to=tmp, max_bytes=MAX_BYTES)
            with open(tmp, "rb") as f:
                if not f.read(5).startswith(b"%PDF-"):
                    raise FetchError("not a PDF (no %PDF- magic)")
                f.seek(0)
                digest = hashlib.file_digest(f, "sha256").hexdigest()
            r2_put(key, tmp)
            d1_exec_statements([
                f"UPDATE papers SET pdf_key={sql_lit(key)}, pdf_sha256={sql_lit(digest)}, "
                f"pdf_size={size}, pdf_source={sql_lit(s['kind'])}, "
                f"pdf_source_date={sql_lit(s['captured_at'])}, pdf_maybe_stale={stale} "
                f"WHERE id={sql_lit(p['id'])};"], "ingest", chunk=1)
            log(f"  {p['id']:>10} {p['license_code']:<12} {s['kind']:<13} {size:>9} B "
                f"stale={stale} sha256={digest[:12]}")
            return True
        except (FetchError, RuntimeError, OSError) as e:
            log(f"  {p['id']}: {s['kind']} failed: {e}")
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-n", type=int, default=20, help="target sample size (default 20)")
    ap.add_argument("--ids", help="comma-separated paper ids to ingest instead of the sampler")
    ap.add_argument("--force", action="store_true", help="re-download even if pdf_key is set")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    papers = load_candidates()
    ids = a.ids.split(",") if a.ids else choose(papers, a.n)
    ok = skipped = failed = 0
    for pid in ids:
        p = papers.get(pid)
        if not p:
            log(f"  {pid}: no known source (or withdrawn) - skipping")
            failed += 1
            continue
        if p["pdf_key"] and not a.force and not a.dry_run:
            skipped += 1
            continue
        if ingest(p, a.dry_run):
            ok += 1
        else:
            failed += 1
    tmpdir = os.path.join(DATA_DIR, "tmp")
    if os.path.isdir(tmpdir) and not os.listdir(tmpdir):
        os.rmdir(tmpdir)
    log(f"sample: {len(ids)} papers; ingested {ok}, already present {skipped}, failed {failed}")
    print(d1_query("SELECT count(*) AS mirrored, sum(pdf_size) AS bytes, sum(pdf_maybe_stale) AS stale "
                   "FROM papers WHERE pdf_key IS NOT NULL")[0])


if __name__ == "__main__":
    main()
