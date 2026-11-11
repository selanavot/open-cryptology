#!/usr/bin/env python3
"""Scheduled ePrint metadata harvest straight into the production D1 (run by GitHub Actions).

ePrint's Cloudflare challenges requests from Cloudflare Workers, so the Worker cron can't harvest;
GitHub Actions runners get real OAI-PMH XML. This script:

  1. reads meta.last_harvest from remote D1 (Cloudflare D1 HTTP API),
  2. fetches OAI-PMH ListRecords (oai_dc) from that datestamp minus --lookback-days, following
     resumptionTokens (one client, >= 3 s between pages, at most --max-pages pages). The look-back
     is needed because a new paper's datestamp is its submission time, but it only appears in OAI
     once an editor approves it, often days later: harvesting strictly from the watermark missed
     those papers (2026-11: 2026/2809-2827),
  3. upserts each record that is new or whose datestamp changed, exactly like worker/src/oai.ts
     `upsert` (FTS delete -> guarded upsert -> FTS insert, one transaction per record batch);
     records we already hold unchanged are skipped (no D1 writes),
  4. reads ePrint's RSS feed once (the 100 most recently changed papers, each with its current
     PDF's byte size) and records that size; a paper we hold a PDF for is "may be outdated"
     exactly when the sizes differ. This tells a new PDF from a metadata-only edit (e.g.
     publication info), which OAI can't. RSS problems only warn: the OAI harvest still counts,
  5. advances meta.last_harvest and writes meta.harvest_last_run / meta.harvest_last_ok.

It fails loudly (non-zero exit, `::error::` line for GitHub) on: HTTP status != 200, a body that
isn't OAI-PMH (Cloudflare challenge / block page), an OAI error other than noRecordsMatch, or any
D1 API error. Metadata only: never fetches PDFs.

Env:
  CLOUDFLARE_API_TOKEN   (required) API token with Account > D1 > Edit
  CF_ACCOUNT_ID, D1_DATABASE_ID   (default: the production ids below)
  OAI_BASE               (default https://eprint.iacr.org/oai; override for testing)
  RSS_URL                (default https://eprint.iacr.org/rss/rss.xml; "off" to skip)

Usage: python3 -I pipeline/harvest_remote.py [--max-pages N] [--lookback-days D] [--dry-run]
"""

import argparse
import json
import os
import sys
import time
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harvest_oai import META_COLS, parse_page  # noqa: E402  (shared OAI parsing/normalization)

DEFAULT_ACCOUNT = "f1a5c2273555ad714cc5911124e671a7"
DEFAULT_DB = "18ccadd9-a999-4b68-8ba6-8db45cd0d5a3"
DEFAULT_OAI = "https://eprint.iacr.org/oai"
DEFAULT_RSS = "https://eprint.iacr.org/rss/rss.xml"
LOOKBACK_DAYS = 30  # covers ePrint's approval delay; ~640 records (2 pages) per run in 2026
USER_AGENT = ("open-cryptology-harvester/0.1 (unofficial non-commercial ePrint mirror; "
              "https://opencryptology.org)")
PAGE_GAP_S = 3.0
# Same set as worker/src/license.ts LICENSE_CODES: the Worker maps anything else to NULL.
LICENSE_CODES = {"CC BY", "CC BY-SA", "CC BY-NC", "CC BY-NC-SA", "CC BY-NC-ND", "CC0"}
RECORDS_PER_BATCH = 50  # 3 statements each


class HarvestError(Exception):
    pass


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# --------------------------------------------------------------------------- D1 HTTP API

class D1:
    def __init__(self, token, account, db):
        self.url = (f"https://api.cloudflare.com/client/v4/accounts/{account}"
                    f"/d1/database/{db}/query")
        self.token = token

    def _post(self, body):
        req = urllib.request.Request(
            self.url, data=json.dumps(body).encode(), method="POST",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
                     "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                status, raw = resp.status, resp.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except (urllib.error.URLError, OSError) as e:
            raise HarvestError(f"D1 API unreachable: {e}") from e
        try:
            data = json.loads(raw)
        except ValueError:
            raise HarvestError(f"D1 API HTTP {status}: non-JSON response {raw[:200]!r}")
        if status != 200 or not data.get("success"):
            errs = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in data.get("errors") or [])
            hint = (" (check that CLOUDFLARE_API_TOKEN is valid and has Account > D1 > Edit)"
                    if status in (401, 403) else "")
            raise HarvestError(f"D1 API error (HTTP {status}): {errs or data}{hint}")
        results = data.get("result") or []
        for r in results:
            if not r.get("success", True):
                raise HarvestError(f"D1 statement failed: {r}")
        return results

    def query(self, sql, params=()):
        return self._post({"sql": sql, "params": list(params)})[0].get("results") or []

    def batch(self, stmts):
        """stmts: [(sql, params)]. Runs as one D1 batch (a transaction)."""
        if stmts:
            self._post({"batch": [{"sql": s, "params": list(p)} for s, p in stmts]})


def get_meta(d1, keys):
    ph = ",".join(f"?{i + 1}" for i in range(len(keys)))
    rows = d1.query(f"SELECT key, value FROM meta WHERE key IN ({ph})", keys)
    return {r["key"]: r["value"] for r in rows}


def meta_stmt(key, value):
    return ("INSERT INTO meta(key, value) VALUES (?1, ?2) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])


# --------------------------------------------------------------------------- upsert (= oai.ts)

GUARD = "WHERE papers.updated IS NULL OR excluded.updated >= papers.updated"
FTS_DELETE = ("INSERT INTO papers_fts(papers_fts, rowid, id, title, authors, abstract) "
              "SELECT 'delete', rowid, id, title, authors, abstract FROM papers WHERE id = ?1")
FTS_INSERT = ("INSERT INTO papers_fts(rowid, id, title, authors, abstract) "
              "SELECT rowid, id, title, authors, abstract FROM papers WHERE id = ?1")
WITHDRAWN_SQL = (
    # Deleted records carry no metadata: an existing paper keeps its metadata and PDFs; only the
    # flag, the datestamp and the withdrawal day change. New ones get an empty-title stub.
    "INSERT INTO papers (id,year,num,title,authors,retro_license,updated,withdrawn,withdrawn_on) "
    "VALUES (?1,?2,?3,'','[]',?4,?5,1,substr(?5,1,10)) "
    "ON CONFLICT(id) DO UPDATE SET updated=excluded.updated, withdrawn=1, "
    "withdrawn_on=CASE WHEN papers.withdrawn = 1 AND papers.withdrawn_on IS NOT NULL "
    f"THEN papers.withdrawn_on ELSE excluded.withdrawn_on END {GUARD}")
LIVE_COLS = ["id", "year", "num"] + META_COLS
# ePrint changed the paper after our copy was captured -> our PDF may be an older revision
# ("may be outdated": yellow on /missing, upload accepted). Only when the datestamp actually
# moves forward, so re-fetching the same record (OAI from= is inclusive) never re-flags a copy an
# upload has confirmed since. Same expression in worker/src/oai.ts and harvest_oai.py.
STALE_SET = (
    "pdf_maybe_stale=CASE WHEN papers.pdf_key IS NOT NULL "
    "AND (papers.updated IS NULL OR excluded.updated > papers.updated) "
    "AND (papers.pdf_source_date IS NULL OR julianday(papers.pdf_source_date) < julianday(excluded.updated)) "
    "THEN 1 ELSE papers.pdf_maybe_stale END")
LIVE_SQL = (
    # A live record clears any withdrawal; affiliations (not in OAI) survive only while the
    # author list is unchanged.
    f"INSERT INTO papers ({','.join(LIVE_COLS)}) "
    f"VALUES ({','.join(f'?{i + 1}' for i in range(len(LIVE_COLS)))}) "
    f"ON CONFLICT(id) DO UPDATE SET {', '.join(f'{c}=excluded.{c}' for c in META_COLS)}, "
    "withdrawn_on=NULL, "
    "affiliations=CASE WHEN excluded.authors = papers.authors THEN papers.affiliations ELSE NULL END, "
    f"{STALE_SET} "
    f"{GUARD}")


def normalize(r):
    """Align harvest_oai.parse_page output with worker/src/oai.ts parseGetRecord."""
    if r.get("license_code") not in LICENSE_CODES:
        r["license_code"] = None
    return r


def upsert_stmts(r):
    if r["withdrawn"]:
        main = (WITHDRAWN_SQL, [r["id"], r["year"], r["num"], r["retro_license"], r["updated"]])
    else:
        main = (LIVE_SQL, [r.get(c) for c in LIVE_COLS])
    return [(FTS_DELETE, [r["id"]]), main, (FTS_INSERT, [r["id"]])]


# --------------------------------------------------------------------------- OAI fetch

BLOCK_MARKERS = ("just a moment", "attention required", "you have been blocked", "cf-chl",
                 "challenge-platform", "cf-browser-verification", "cloudflare")


def fetch_page(url):
    """GET one OAI page; returns the body. Raises HarvestError on anything but 200 + OAI-PMH XML.

    Retries (twice, 30/60 s apart) only on network errors and 5xx; never on 403/429.
    """
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                       "Accept": "application/xml, text/xml"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                status, body = resp.status, resp.read()
            why = None
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read()
            why = f"HTTP {status}" if status >= 500 else None
        except (urllib.error.URLError, OSError) as e:
            status, body, why = None, b"", f"network error: {getattr(e, 'reason', e)}"
        if why and attempt < 2:
            log(f"  {why}; retrying in {30 * (attempt + 1)} s")
            time.sleep(30 * (attempt + 1))
            continue
        if why and status is None:
            raise HarvestError(f"ePrint OAI unreachable ({why}) for {url}")
        break
    text = body.decode("utf-8", "replace")
    blocked = any(m in text[:20000].lower() for m in BLOCK_MARKERS) and "<OAI-PMH" not in text
    if status != 200:
        extra = (" -- blocked by ePrint's Cloudflare (challenge/block page)" if blocked
                 else " -- blocked or rate-limited" if status in (403, 429) else "")
        raise HarvestError(f"ePrint OAI returned HTTP {status}{extra} for {url}")
    if "<OAI-PMH" not in text:
        kind = ("blocked: Cloudflare challenge/block page instead of OAI-PMH XML" if blocked
                else "blocked or unexpected response: body is not OAI-PMH XML")
        snippet = " ".join(text[:300].split())
        raise HarvestError(f"ePrint OAI {kind} for {url} (starts: {snippet!r})")
    return body


def oai_url(base, **params):
    return base + "?" + urllib.parse.urlencode(params)


# --------------------------------------------------------------------------- unchanged records

def held_datestamps(d1, ids):
    """{id: updated} for the ids we already hold (one query per 90 ids)."""
    out = {}
    ids = list(dict.fromkeys(ids))
    for i in range(0, len(ids), 90):
        chunk = ids[i:i + 90]
        ph = ",".join(f"?{k + 1}" for k in range(len(chunk)))
        for row in d1.query(f"SELECT id, updated FROM papers WHERE id IN ({ph})", chunk):
            out[row["id"]] = row["updated"]
    return out


# --------------------------------------------------------------------------- RSS: PDF sizes

RSS_ITEM = re.compile(r"<item>(.*?)</item>", re.S)
RSS_GUID = re.compile(r"<guid[^>]*>\s*https?://eprint\.iacr\.org/(\d{4})/(\d+)\s*</guid>")
RSS_ENCLOSURE = re.compile(r"<enclosure\b[^>]*\blength=\"(\d+)\"")


def parse_rss(body):
    """[(id, pdf_size)] from ePrint's RSS feed (items without a PDF enclosure are skipped)."""
    text = body.decode("utf-8", "replace") if isinstance(body, bytes) else body
    out = []
    for item in RSS_ITEM.findall(text):
        g, e = RSS_GUID.search(item), RSS_ENCLOSURE.search(item)
        if g and e and int(e.group(1)) > 0:
            out.append((f"{g.group(1)}/{int(g.group(2)):03d}", int(e.group(1))))
    return out


# A paper we hold a PDF for is outdated exactly when ePrint's current PDF has a different size.
# pdf_latest_at = the OAI datestamp the size belongs to (lets uploads and the paper page tell a
# known-current size from one recorded before a later change). Withdrawn papers aren't touched.
_STALE_BY_SIZE = ("CASE WHEN pdf_key IS NULL OR withdrawn = 1 OR pdf_size IS NULL THEN pdf_maybe_stale "
                  "WHEN pdf_size = ?2 THEN 0 ELSE 1 END")
RSS_UPDATE = (
    f"UPDATE papers SET pdf_latest_size = ?2, pdf_latest_at = updated, pdf_maybe_stale = {_STALE_BY_SIZE} "
    "WHERE id = ?1 AND updated IS NOT NULL AND (?3 IS NULL OR updated <= ?3) "
    f"AND (pdf_latest_size IS NOT ?2 OR pdf_latest_at IS NOT updated OR pdf_maybe_stale IS NOT ({_STALE_BY_SIZE}))")


def rss_stmts(items, observed_at=None):
    """UPDATE statements for RSS (id, size) items. observed_at (ISO): only apply where the paper's
    datestamp is not newer than that (for archived snapshots; None = the live feed)."""
    return [(RSS_UPDATE, [pid, size, observed_at]) for pid, size in items]


def fetch_rss(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               "Accept": "application/rss+xml, application/xml"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            status, body = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        status, body = e.code, b""
    except (urllib.error.URLError, OSError) as e:
        raise HarvestError(f"RSS unreachable: {getattr(e, 'reason', e)}")
    if status != 200 or b"<rss" not in body[:2000]:
        raise HarvestError(f"RSS returned HTTP {status} without an RSS document (blocked or changed?)")
    return body


def check_rss(d1, url, dry_run):
    """Record ePrint's current PDF sizes; returns a summary dict. Never raises (warns)."""
    try:
        items = parse_rss(fetch_rss(url))
        if not items:
            raise HarvestError("RSS feed had no items with a PDF size")
        stmts = rss_stmts(items)
        changed = 0
        if not dry_run:
            for i in range(0, len(stmts), 50):
                res = d1._post({"batch": [{"sql": s, "params": list(p)} for s, p in stmts[i:i + 50]]})
                changed += sum((r.get("meta") or {}).get("changes", 0) for r in res)
        log(f"  RSS: {len(items)} items with a PDF size, {changed} paper(s) updated")
        return {"items": len(items), "changed": changed}
    except HarvestError as e:
        print(f"::warning title=RSS size check skipped::{e}", flush=True)
        log(f"  RSS check skipped: {e}")
        return {"error": str(e)}


# --------------------------------------------------------------------------- main

def harvest(d1, base, max_pages, dry_run, lookback_days=LOOKBACK_DAYS):
    meta = get_meta(d1, ["last_harvest"])
    mark = meta.get("last_harvest")
    if not mark:
        raise HarvestError("meta.last_harvest is missing in D1 (load the initial dump first)")
    back = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - lookback_days * 86400))
    from_ = min(mark, back)
    log(f"OAI harvest from={from_} (watermark {mark}, look-back {lookback_days} d) ({base})")
    summary = {"at": now_iso(), "from": from_, "watermark": mark, "pages": 0, "records": 0,
               "new": 0, "added": 0, "upserted": 0, "newest": mark, "status": "ok",
               "runner": "github-actions"}
    url = oai_url(base, verb="ListRecords", metadataPrefix="oai_dc", **{"from": from_})
    sorted_ok, prev, token = True, None, None
    while url:
        if summary["pages"] >= max_pages:
            break
        if summary["pages"]:
            time.sleep(PAGE_GAP_S)
        body = fetch_page(url)
        summary["pages"] += 1
        try:
            recs, token, err = parse_page(body)
        except ET.ParseError as e:
            raise HarvestError(f"unparseable OAI-PMH XML from {url}: {e}")
        if err == "noRecordsMatch":
            log("  OAI: noRecordsMatch")
            token = None
            break
        if err:
            raise HarvestError(f"OAI error {err} for {url}")
        stmts = []
        held = held_datestamps(d1, [r["id"] for r in recs])
        for r in recs:
            r = normalize(r)
            summary["records"] += 1
            d = r["updated"]
            if d and d > mark:
                summary["new"] += 1
            if d and d > summary["newest"]:
                summary["newest"] = d
            if d and prev and d < prev:
                sorted_ok = False
            prev = d or prev
            if r["id"] in held and held[r["id"]] == d:
                continue  # already hold this exact record
            if r["id"] not in held:
                summary["added"] += 1
            stmts.extend(upsert_stmts(r))
            summary["upserted"] += 1
        for i in range(0, len(stmts), 3 * RECORDS_PER_BATCH):
            if not dry_run:
                d1.batch(stmts[i:i + 3 * RECORDS_PER_BATCH])
        log(f"  page {summary['pages']}: {len(recs)} records (total {summary['records']}, "
            f"upserted {summary['upserted']}, newest {summary['newest']})")
        url = oai_url(base, verb="ListRecords", resumptionToken=token) if token else None

    capped = bool(token)
    if capped:
        if not sorted_ok:
            # Records weren't in datestamp order, so advancing to the newest seen could skip
            # unseen older ones. Keep the watermark; the upserts already done are idempotent.
            raise HarvestError(
                f"page cap ({max_pages}) reached with more pages left, and records were not in "
                "datestamp order, so meta.last_harvest was NOT advanced. Re-run the workflow "
                "manually with a larger max_pages.")
        summary["status"] = f"ok (page cap {max_pages} reached; continuing next run)"
    return summary


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--max-pages", type=int, default=30, help="OAI pages per run (default 30)")
    ap.add_argument("--lookback-days", type=float, default=LOOKBACK_DAYS,
                    help=f"also re-read this many days before the watermark (default {LOOKBACK_DAYS})")
    ap.add_argument("--dry-run", action="store_true", help="fetch and parse, write nothing to D1")
    a = ap.parse_args()

    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        fail("CLOUDFLARE_API_TOKEN is not set. Add a Cloudflare API token with Account > D1 > Edit "
             "as the repository secret CLOUDFLARE_API_TOKEN (Settings > Secrets and variables > "
             "Actions).")
    d1 = D1(token, os.environ.get("CF_ACCOUNT_ID") or DEFAULT_ACCOUNT,
            os.environ.get("D1_DATABASE_ID") or DEFAULT_DB)
    base = (os.environ.get("OAI_BASE") or DEFAULT_OAI).rstrip("/")
    started = now_iso()
    try:
        s = harvest(d1, base, a.max_pages, a.dry_run, a.lookback_days)
        rss = (os.environ.get("RSS_URL") or DEFAULT_RSS).strip()
        if rss != "off":
            time.sleep(PAGE_GAP_S)
            s["rss"] = check_rss(d1, rss, a.dry_run)
        if not a.dry_run:
            stmts = [meta_stmt("harvest_last_run", json.dumps(s)), meta_stmt("harvest_last_ok", now_iso())]
            if s["newest"] > s["watermark"]:
                stmts.insert(0, ("INSERT INTO meta(key, value) VALUES ('last_harvest', ?1) "
                                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value "
                                 "WHERE meta.value IS NULL OR excluded.value > meta.value",
                                 [s["newest"]]))
            d1.batch(stmts)
    except HarvestError as e:
        if not a.dry_run:
            try:  # record the failure for the site/status, but never harvest_last_ok
                d1.batch([meta_stmt("harvest_last_run", json.dumps(
                    {"at": started, "status": f"error: {e}", "runner": "github-actions"}))])
            except HarvestError:
                pass
        fail(str(e))
    r = s.get("rss") or {}
    rss_part = (f"; RSS: {r['items']} sizes, {r['changed']} paper(s) updated" if "items" in r
                else f"; RSS skipped ({r['error']})" if "error" in r else "")
    line = (f"harvest ok: {s['pages']} page(s) from {s['from']}, {s['records']} records ({s['new']} "
            f"newer than {s['watermark']}), {s['upserted']} upserted ({s['added']} new papers), "
            f"last_harvest -> {s['newest']}{rss_part}"
            + (" [dry run]" if a.dry_run else "") + f"; status: {s['status']}")
    print(line, flush=True)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write(f"### Metadata harvest\n\n{line}\n")


def fail(msg):
    print(f"::error title=Metadata harvest failed::{msg}", flush=True)
    log(f"HARVEST FAILED: {msg}")
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write(f"### Metadata harvest FAILED\n\n{msg}\n")
    sys.exit(1)


if __name__ == "__main__":
    main()
