#!/usr/bin/env python3
"""Scheduled ePrint metadata harvest straight into the production D1 (run by GitHub Actions).

ePrint's Cloudflare challenges requests from Cloudflare Workers, so the Worker cron can't harvest;
GitHub Actions runners get real OAI-PMH XML. This script:

  1. reads meta.last_harvest from remote D1 (Cloudflare D1 HTTP API),
  2. fetches OAI-PMH ListRecords (oai_dc) from that datestamp, following resumptionTokens
     (one client, >= 3 s between pages, at most --max-pages pages),
  3. upserts each record exactly like worker/src/oai.ts `upsert` (FTS delete -> guarded upsert ->
     FTS insert, one transaction per record batch),
  4. advances meta.last_harvest and writes meta.harvest_last_run / meta.harvest_last_ok.

It fails loudly (non-zero exit, `::error::` line for GitHub) on: HTTP status != 200, a body that
isn't OAI-PMH (Cloudflare challenge / block page), an OAI error other than noRecordsMatch, or any
D1 API error. Metadata only: never fetches PDFs.

Env:
  CLOUDFLARE_API_TOKEN   (required) API token with Account > D1 > Edit
  CF_ACCOUNT_ID, D1_DATABASE_ID   (default: the production ids below)
  OAI_BASE               (default https://eprint.iacr.org/oai; override for testing)

Usage: python3 -I pipeline/harvest_remote.py [--max-pages N] [--dry-run]
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harvest_oai import META_COLS, parse_page  # noqa: E402  (shared OAI parsing/normalization)

DEFAULT_ACCOUNT = "f1a5c2273555ad714cc5911124e671a7"
DEFAULT_DB = "18ccadd9-a999-4b68-8ba6-8db45cd0d5a3"
DEFAULT_OAI = "https://eprint.iacr.org/oai"
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
LIVE_SQL = (
    # A live record clears any withdrawal; affiliations (not in OAI) survive only while the
    # author list is unchanged.
    f"INSERT INTO papers ({','.join(LIVE_COLS)}) "
    f"VALUES ({','.join(f'?{i + 1}' for i in range(len(LIVE_COLS)))}) "
    f"ON CONFLICT(id) DO UPDATE SET {', '.join(f'{c}=excluded.{c}' for c in META_COLS)}, "
    "withdrawn_on=NULL, "
    "affiliations=CASE WHEN excluded.authors = papers.authors THEN papers.affiliations ELSE NULL END "
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


# --------------------------------------------------------------------------- main

def harvest(d1, base, max_pages, dry_run):
    meta = get_meta(d1, ["last_harvest"])
    from_ = meta.get("last_harvest")
    if not from_:
        raise HarvestError("meta.last_harvest is missing in D1 (load the initial dump first)")
    log(f"OAI harvest from={from_} ({base})")
    summary = {"at": now_iso(), "from": from_, "pages": 0, "records": 0, "new": 0, "upserted": 0,
               "newest": from_, "status": "ok", "runner": "github-actions"}
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
        for r in recs:
            r = normalize(r)
            summary["records"] += 1
            d = r["updated"]
            if d and d > from_:
                summary["new"] += 1
            if d and d > summary["newest"]:
                summary["newest"] = d
            if d and prev and d < prev:
                sorted_ok = False
            prev = d or prev
            stmts.extend(upsert_stmts(r))
        for i in range(0, len(stmts), 3 * RECORDS_PER_BATCH):
            if not dry_run:
                d1.batch(stmts[i:i + 3 * RECORDS_PER_BATCH])
        summary["upserted"] += len(recs)
        log(f"  page {summary['pages']}: {len(recs)} records (total {summary['records']}, "
            f"newest {summary['newest']})")
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
        s = harvest(d1, base, a.max_pages, a.dry_run)
        if not a.dry_run:
            stmts = [meta_stmt("harvest_last_run", json.dumps(s)), meta_stmt("harvest_last_ok", now_iso())]
            if s["newest"] > s["from"]:
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
    line = (f"harvest ok: {s['pages']} page(s), {s['records']} records ({s['new']} new since "
            f"{s['from']}), {s['upserted']} upserted, last_harvest -> {s['newest']}"
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
