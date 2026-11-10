#!/usr/bin/env python3
"""Discover where each paper's PDF can be fetched (WITHOUT downloading any PDF) -> D1 `sources`.

Sources:
  github-mirror  arturo-kong/IACR-eprint-mirror (listing via `gh api` git trees). captured_at is
                 the date of the earliest commit that contains the file's *current* blob, found
                 by walking the repo's commit history (the repo is small in commits, ~32). This is
                 the commit date, i.e. when the PDF was pushed, which is at or slightly after
                 when it was downloaded from ePrint. tuxxy/IACR-eprint-mirror is an ancestor of
                 arturo-kong's history (its HEAD is a commit there), so it adds nothing.
  wayback        Wayback Machine CDX API, one prefix query over eprint.iacr.org/ using the CDX
                 pagination API (page=0..N-1, server-side filters: urlkey /YYYY/NNNN.pdf, mimetype
                 application/pdf or warc/revisit). Per paper, the latest capture whose payload is
                 a 200 PDF (revisits count when their digest matches a PDF capture).
                 url = https://web.archive.org/web/<ts>id_/<original>.
                 size = CDX `length` of the PDF capture (archived record length, approximate).

Raw listing responses are cached under data/cache/discover/ so a run interrupted by Wayback
throttling resumes where it left off; the cache is deleted after a successful run unless
--keep-cache.

Usage (from repo root):
  python3 -I pipeline/discover_sources.py                 # both sources, all years
  python3 -I pipeline/discover_sources.py --skip-wayback
  python3 -I pipeline/discover_sources.py --years 2024,2025 --skip-github
  python3 -I pipeline/discover_sources.py --stats-only    # just print coverage
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (DATA_DIR, FetchError, d1_exec_statements, d1_query, log,  # noqa: E402
                    polite_get, sql_lit)

GH_REPO = "arturo-kong/IACR-eprint-mirror"
CDX = "https://web.archive.org/cdx/search/cdx"
PDF_RE = re.compile(r"^https?://(?:www\.)?eprint\.iacr\.org(?::\d+)?/(\d{4})/(\d{3,5})\.pdf$")
CACHE = os.path.join(DATA_DIR, "cache", "discover")


# --------------------------------------------------------------------------- helpers

def cached(name, fn):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, name)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    v = fn()
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(v, f)
    os.replace(tmp, p)
    return v


def gh_api(path):
    for attempt in range(5):
        r = subprocess.run(["gh", "api", path], capture_output=True, text=True)
        if r.returncode == 0:
            return json.loads(r.stdout)
        log(f"  gh api {path} failed ({r.stderr.strip()[:200]}); retry in {10 * (attempt + 1)}s")
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"gh api {path} kept failing")


def load_papers():
    rows = d1_query("SELECT id, year, num, updated, withdrawn FROM papers")
    return {(r["year"], r["num"]): r for r in rows}


def sources_sql(kind, entries):
    """entries: list of (paper_id, url, captured_at, size). Multi-row upserts, 100 rows each."""
    stmts = []
    for i in range(0, len(entries), 100):
        vals = ",".join(f"({sql_lit(p)},{sql_lit(kind)},{sql_lit(u)},{sql_lit(c)},{sql_lit(s)})"
                        for p, u, c, s in entries[i:i + 100])
        stmts.append("INSERT INTO sources (paper_id,kind,url,captured_at,size) VALUES " + vals +
                     " ON CONFLICT(paper_id,kind) DO UPDATE SET url=excluded.url, "
                     "captured_at=excluded.captured_at, size=excluded.size;")
    return stmts


# --------------------------------------------------------------------------- GitHub mirror

def discover_github(papers, years, repo=GH_REPO):
    info = gh_api(f"repos/{repo}")
    branch = info["default_branch"]
    commits = []
    page = 1
    while True:
        batch = gh_api(f"repos/{repo}/commits?sha={branch}&per_page=100&page={page}")
        commits += batch
        if len(batch) < 100:
            break
        page += 1
    commits.sort(key=lambda c: c["commit"]["committer"]["date"])
    head = commits[-1]["sha"]
    log(f"github {repo}@{branch}: {len(commits)} commits, head {head[:8]}")

    first_seen = {}      # (path, blob sha) -> earliest commit date containing it
    tree_cache = {}      # year-tree sha -> list of blobs
    head_blobs = {}      # path -> (blob sha, size) at HEAD
    for c in commits:
        date = c["commit"]["committer"]["date"]
        root = cached(f"gh-root-{c['commit']['tree']['sha']}.json",
                      lambda: gh_api(f"repos/{repo}/git/trees/{c['commit']['tree']['sha']}"))
        for ent in root["tree"]:
            if ent["type"] != "tree" or not ent["path"].isdigit():
                continue
            if years and int(ent["path"]) not in years:
                continue
            tsha = ent["sha"]
            if tsha not in tree_cache:
                t = cached(f"gh-tree-{tsha}.json", lambda: gh_api(f"repos/{repo}/git/trees/{tsha}"))
                if t.get("truncated"):
                    log(f"  WARNING: tree {ent['path']}@{tsha[:8]} truncated")
                tree_cache[tsha] = [(f"{ent['path']}/{b['path']}", b["sha"], b.get("size"))
                                    for b in t["tree"] if b["type"] == "blob"]
            for path, bsha, size in tree_cache[tsha]:
                first_seen.setdefault((path, bsha), date)
                if c["sha"] == head:
                    head_blobs[path] = (bsha, size)

    entries, unknown, other_ext = [], 0, 0
    for path, (bsha, size) in head_blobs.items():
        m = re.match(r"^(\d{4})/(\d+)\.pdf$", path)
        if not m:
            other_ext += 1
            continue
        p = papers.get((int(m.group(1)), int(m.group(2))))
        if not p:
            unknown += 1
            continue
        url = f"https://raw.githubusercontent.com/{repo}/{branch}/{path}"
        entries.append((p["id"], url, first_seen[(path, bsha)], size))
    log(f"github: {len(entries)} PDFs matched to papers, {unknown} with unknown ids, "
        f"{other_ext} non-PDF files")
    return entries


# --------------------------------------------------------------------------- Wayback CDX

def cdx_json(params, label):
    """One CDX request -> parsed JSON, patiently retrying IA's throttling (HTML 'Temporarily
    Offline' pages, 5xx, refused connections). ~1 request per 5 s at best."""
    url = CDX + "?" + urllib.parse.urlencode(params)
    for attempt in range(10):
        body = polite_get(url, min_interval=5.0, max_tries=10, base_backoff=30,
                          max_backoff=900, timeout=300)
        try:
            return json.loads(body or b"[]")
        except ValueError:
            wait = min(60 * 2 ** attempt, 900)
            log(f"  cdx {label}: non-JSON reply (IA throttling?); sleeping {wait}s")
            time.sleep(wait)
    raise FetchError(f"CDX {label}: no JSON after retries")


CDX_FL = "original,timestamp,length,mimetype,statuscode,digest"


def cdx_captures():
    """Captures of eprint.iacr.org/YYYY/NNNN.pdf URLs (real PDFs and warc/revisit records), using
    the CDX pagination API over the eprint.iacr.org/ prefix (168 pages of index blocks on
    2026-11-10; few, cheap-to-serve requests). Server-side filters keep only paper-PDF URL keys.
    Rows: [original, timestamp, length, mimetype, statuscode, digest]."""
    base = [("url", "eprint.iacr.org/"), ("matchType", "prefix")]
    npages = cached("cdx-numpages.json",
                    lambda: cdx_json(base + [("showNumPages", "true"), ("output", "json")], "numpages"))
    if isinstance(npages, list):  # output=json gives [["numpages"], ["168"]]
        npages = npages[-1][0] if isinstance(npages[-1], list) else npages[-1]
    npages = int(npages)
    log(f"wayback: {npages} CDX index pages for eprint.iacr.org/")
    rows = []
    for page in range(npages):
        t0 = time.time()
        params = base + [("filter", r"urlkey:.*/[0-9]{4}/[0-9]{3,5}\.pdf$"),
                         ("filter", "mimetype:application/pdf|warc/revisit"),
                         ("fl", CDX_FL), ("output", "json"), ("page", str(page))]
        data = cached(f"cdx-page-{page}.json", lambda: cdx_json(params, f"page {page}"))
        body = [r for r in data if len(r) == 6 and r[0] != "original"]
        rows += body
        log(f"  cdx page {page + 1}/{npages}: {len(body)} paper-pdf captures ({time.time() - t0:.0f}s)")
    return rows


def ts_iso(ts):
    return f"{ts[0:4]}-{ts[4:6]}-{ts[6:8]}T{ts[8:10]}:{ts[10:12]}:{ts[12:14]}Z"


def discover_wayback(papers, years):
    """Latest capture per paper whose payload is a real PDF: either a 200 application/pdf
    capture, or a warc/revisit whose digest equals one of those (IA records unchanged re-crawls
    as revisits; `id_` replay of a revisit returns the original bytes). Size comes from the
    PDF capture's record length (approximate)."""
    per_paper = {}
    for original, ts, length, mime, status, digest in cdx_captures():
        m = PDF_RE.match(original)
        if not m or int(m.group(1)) not in years:
            continue
        p = papers.get((int(m.group(1)), int(m.group(2))))
        if p:
            per_paper.setdefault(p["id"], []).append((ts, original, length, mime, status, digest))
    out, via_revisit = [], 0
    for pid, caps in per_paper.items():
        pdf_sizes = {}
        for ts, orig, length, mime, status, digest in caps:
            if mime == "application/pdf" and status == "200":
                pdf_sizes[digest] = int(length) if length.isdigit() else None
        good = [c for c in caps if c[5] in pdf_sizes and
                ((c[3] == "application/pdf" and c[4] == "200") or c[3] == "warc/revisit")]
        if not good:
            continue
        ts, orig, length, mime, status, digest = max(good)
        via_revisit += mime == "warc/revisit"
        out.append((pid, f"https://web.archive.org/web/{ts}id_/{orig}", ts_iso(ts), pdf_sizes[digest]))
    log(f"wayback: latest PDF capture for {len(out)} papers ({via_revisit} latest is a revisit); "
        f"{len(per_paper) - len(out)} papers only have non-PDF/failed captures")
    return out


# --------------------------------------------------------------------------- stats

STATS_SQL = """
SELECT p.year AS year,
       count(*) AS papers,
       sum(EXISTS(SELECT 1 FROM sources s WHERE s.paper_id=p.id AND s.kind='github-mirror')) AS github,
       sum(EXISTS(SELECT 1 FROM sources s WHERE s.paper_id=p.id AND s.kind='wayback')) AS wayback,
       sum(EXISTS(SELECT 1 FROM sources s WHERE s.paper_id=p.id)) AS any_src,
       sum(EXISTS(SELECT 1 FROM sources s WHERE s.paper_id=p.id AND s.captured_at >= p.updated)) AS fresh
FROM papers p WHERE p.withdrawn=0 GROUP BY p.year ORDER BY p.year
"""


def print_stats():
    rows = d1_query(STATS_SQL)
    tot = {k: 0 for k in ("papers", "github", "wayback", "any_src", "fresh")}
    print(f"{'year':>5} {'papers':>7} {'github':>7} {'wayback':>8} {'any':>7} {'fresh':>7}  any%  fresh%")
    for r in rows:
        for k in tot:
            tot[k] += r[k] or 0
        print(f"{r['year']:>5} {r['papers']:>7} {r['github']:>7} {r['wayback']:>8} {r['any_src']:>7} "
              f"{r['fresh']:>7} {100 * r['any_src'] / r['papers']:5.1f} {100 * r['fresh'] / r['papers']:6.1f}")
    print(f"{'all':>5} {tot['papers']:>7} {tot['github']:>7} {tot['wayback']:>8} {tot['any_src']:>7} "
          f"{tot['fresh']:>7} {100 * tot['any_src'] / tot['papers']:5.1f} "
          f"{100 * tot['fresh'] / tot['papers']:6.1f}")
    print("(non-withdrawn papers; fresh = some source captured at/after the OAI datestamp `updated`)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--years", help="comma list / range, e.g. 2024,2025 or 1996-2010 (default: all)")
    ap.add_argument("--skip-github", action="store_true")
    ap.add_argument("--skip-wayback", action="store_true")
    ap.add_argument("--keep-cache", action="store_true")
    ap.add_argument("--stats-only", action="store_true")
    a = ap.parse_args()

    if a.stats_only:
        print_stats()
        return
    papers = load_papers()
    all_years = sorted({y for y, _ in papers})
    years = set(all_years)
    if a.years:
        years = set()
        for part in a.years.split(","):
            lo, _, hi = part.partition("-")
            years.update(range(int(lo), int(hi or lo) + 1))
    log(f"{len(papers)} papers in D1; years {min(years)}-{max(years)}")

    if not a.skip_github:
        e = discover_github(papers, None if not a.years else years)
        d1_exec_statements(sources_sql("github-mirror", e), "sources-github", chunk=50)
    if not a.skip_wayback:
        e = discover_wayback(papers, sorted(years))
        d1_exec_statements(sources_sql("wayback", e), "sources-wayback", chunk=50)
    if not a.keep_cache:
        shutil.rmtree(CACHE, ignore_errors=True)
    print_stats()


if __name__ == "__main__":
    main()
