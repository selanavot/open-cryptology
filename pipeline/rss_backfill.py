#!/usr/bin/env python3
"""One-off: record ePrint's PDF sizes from archived copies of its RSS feed (Wayback Machine).

The harvest (harvest_remote.py) reads the live RSS feed every run, but the feed only holds the 100
most recently changed papers. For papers flagged "may be outdated" before that existed, archived
snapshots of the feed can still tell a new PDF from a metadata-only edit: a snapshot taken after a
paper's last change (papers.updated <= snapshot time) shows the size of its current PDF.

Reads the Wayback CDX list of https://eprint.iacr.org/rss/rss.xml captures, replays each distinct
capture (one client, >= 2 s apart), and writes one SQL file of guarded UPDATEs (same statement as
the harvest, oldest snapshot first so later ones win) to apply with wrangler:

  python3 -I pipeline/rss_backfill.py --from 20260401 --out data/rss-backfill.sql
  cd worker && npx --no-install wrangler d1 execute open-cryptology --remote --file ../data/rss-backfill.sql

Idempotent. Fetches nothing from eprint.iacr.org itself.
"""

import argparse
import gzip
import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harvest_remote import USER_AGENT, parse_rss, rss_stmts  # noqa: E402

CDX = "https://web.archive.org/cdx/search/cdx"
FEED = "eprint.iacr.org/rss/rss.xml"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
    return gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body


def sql_lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def inline(sql, params):
    for i in range(len(params), 0, -1):  # ?10 before ?1
        sql = sql.replace(f"?{i}", sql_lit(params[i - 1]))
    return sql


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="from_", default="20260401", help="first capture (YYYYMMDD)")
    ap.add_argument("--out", required=True, help="SQL file to write")
    a = ap.parse_args()

    q = urllib.parse.urlencode({"url": FEED, "from": a.from_, "filter": "statuscode:200",
                                "fl": "timestamp,digest", "collapse": "digest", "output": "json"})
    rows = json.loads(get(f"{CDX}?{q}"))[1:]
    print(f"{len(rows)} distinct captures since {a.from_}", file=sys.stderr)
    stmts, papers = [], set()
    for i, (ts, _digest) in enumerate(sorted(rows)):
        if i:
            time.sleep(2)
        try:
            items = parse_rss(get(f"https://web.archive.org/web/{ts}id_/https://{FEED}"))
        except Exception as e:  # one bad capture shouldn't stop the rest
            print(f"  {ts}: skipped ({e})", file=sys.stderr)
            continue
        iso = f"{ts[0:4]}-{ts[4:6]}-{ts[6:8]}T{ts[8:10]}:{ts[10:12]}:{ts[12:14]}Z"
        stmts += [inline(s, p) + ";" for s, p in rss_stmts(items, observed_at=iso)]
        papers.update(pid for pid, _ in items)
        print(f"  {ts}: {len(items)} items", file=sys.stderr)
    with open(a.out, "w") as f:
        f.write("\n".join(stmts) + "\n")
    print(f"wrote {len(stmts)} statements for {len(papers)} papers to {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
