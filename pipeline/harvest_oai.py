#!/usr/bin/env python3
"""Incremental OAI-PMH harvest of ePrint metadata (oai_dc, CC0) into D1 `papers`.

Usage (from repo root):
  python3 -I pipeline/harvest_oai.py                       # incremental from meta.last_harvest
  python3 -I pipeline/harvest_oai.py --from 2026-11-01T00:00:00Z
  python3 -I pipeline/harvest_oai.py --from-dir /path/to/oai   # load saved page*.xml, no network
  python3 -I pipeline/harvest_oai.py --full                 # ignore meta.last_harvest

Upserts metadata columns only (pdf_* columns are never touched), skips records older than what
is already stored, rebuilds FTS, and advances meta.last_harvest to the max datestamp seen.
"""

import argparse
import glob
import json
import os
import re
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import FetchError, d1_exec_statements, d1_query, log, polite_get, sql_lit  # noqa: E402

OAI_URL = "https://eprint.iacr.org/oai"
NS = {
    "oai": "http://www.openarchives.org/OAI/2.0/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "oai_dc": "http://www.openarchives.org/OAI/2.0/oai_dc/",
}
ID_RE = re.compile(r"^oai:eprint\.iacr\.org:(\d{4})/(\d+)$")

META_COLS = ["title", "authors", "abstract", "category", "license_url", "license_code",
             "retro_license", "submitted", "updated", "withdrawn"]


def license_code(url):
    if not url:
        return None
    u = url.strip().lower()
    if "publicdomain/zero" in u:
        return "CC0"
    m = re.search(r"creativecommons\.org/licenses/([a-z-]+)/", u)
    if m:
        return "CC " + m.group(1).upper()
    return None


def _text(el):
    return re.sub(r"\s+", " ", el.text or "").strip() if el is not None else ""


def parse_page(xml_bytes):
    """Return (records, resumption_token, error_code). Each record is a dict."""
    root = ET.fromstring(xml_bytes)
    err = root.find("oai:error", NS)
    if err is not None:
        return [], None, err.get("code")
    out = []
    for rec in root.iterfind(".//oai:ListRecords/oai:record", NS):
        h = rec.find("oai:header", NS)
        ident = (h.findtext("oai:identifier", "", NS) or "").strip()
        m = ID_RE.match(ident)
        if not m:
            log(f"  skipping unexpected identifier {ident!r}")
            continue
        year, numstr = int(m.group(1)), m.group(2)
        r = {
            "id": f"{year}/{numstr}",
            "year": year,
            "num": int(numstr),
            "updated": (h.findtext("oai:datestamp", "", NS) or "").strip() or None,
            "withdrawn": 1 if h.get("status") == "deleted" else 0,
            "retro_license": 1 if year < 2022 else 0,
        }
        dc = rec.find("oai:metadata/oai_dc:dc", NS)
        if dc is not None and not r["withdrawn"]:
            rights = _text(dc.find("dc:rights", NS)) or None
            desc = dc.find("dc:description", NS)
            dates = [_text(d) for d in dc.findall("dc:date", NS)]
            r.update({
                "title": _text(dc.find("dc:title", NS)),
                "authors": json.dumps([_text(c) for c in dc.findall("dc:creator", NS) if _text(c)],
                                      ensure_ascii=False),
                "abstract": (desc.text or "").strip() if desc is not None else None,
                "category": _text(dc.find("dc:subject", NS)) or None,
                "license_url": rights,
                "license_code": license_code(rights),
                "submitted": dates[0] if dates else None,
            })
        out.append(r)
    tok_el = root.find(".//oai:ListRecords/oai:resumptionToken", NS)
    token = (tok_el.text or "").strip() if tok_el is not None else None
    return out, token or None, None


def upsert_sql(r):
    # Only overwrite when the incoming datestamp is not older than what we have.
    guard = "WHERE papers.updated IS NULL OR excluded.updated >= papers.updated"
    if r["withdrawn"]:
        # Deleted records carry no metadata: keep whatever we had (metadata, PDFs), just flag it
        # and record the withdrawal day (the deleted record's datestamp unless already known).
        return ("INSERT INTO papers (id,year,num,title,authors,retro_license,updated,withdrawn,withdrawn_on) "
                f"VALUES ({sql_lit(r['id'])},{r['year']},{r['num']},'','[]',{r['retro_license']},"
                f"{sql_lit(r['updated'])},1,{sql_lit((r['updated'] or '')[:10] or None)}) "
                "ON CONFLICT(id) DO UPDATE SET updated=excluded.updated, withdrawn=1, "
                "withdrawn_on=CASE WHEN papers.withdrawn = 1 AND papers.withdrawn_on IS NOT NULL "
                f"THEN papers.withdrawn_on ELSE excluded.withdrawn_on END {guard};")
    cols = ["id", "year", "num"] + META_COLS
    vals = ",".join(sql_lit(r.get(c)) for c in cols)
    sets = ", ".join(f"{c}=excluded.{c}" for c in META_COLS)
    # A live record clears any withdrawal; affiliations (not in OAI) survive only while the author
    # list is unchanged.
    return (f"INSERT INTO papers ({','.join(cols)}) VALUES ({vals}) "
            f"ON CONFLICT(id) DO UPDATE SET {sets}, withdrawn_on=NULL, "
            "affiliations=CASE WHEN excluded.authors = papers.authors THEN papers.affiliations ELSE NULL END "
            f"{guard};")


def iter_dir(d):
    files = glob.glob(os.path.join(d, "*.xml"))
    files.sort(key=lambda p: [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", p)])
    for p in files:
        with open(p, "rb") as f:
            recs, _tok, err = parse_page(f.read())
        if err:
            log(f"  {p}: OAI error {err}")
        yield os.path.basename(p), recs


def iter_live(from_, until=None, save_dir=None, min_interval=3.0, base=OAI_URL):
    params = {"verb": "ListRecords", "metadataPrefix": "oai_dc"}
    if from_:
        params["from"] = from_
    if until:
        params["until"] = until
    url = base + "?" + urllib.parse.urlencode(params)
    page = 0
    while url:
        page += 1
        # One client, >= 3 s apart; stop at the first 403/429 (never retry those), and only a
        # few patient retries on 5xx / network errors.
        body = polite_get(url, min_interval=min_interval, max_tries=3, base_backoff=30,
                          fatal_status=(403, 429))
        if save_dir:
            os.makedirs(save_dir, exist_ok=True)
            with open(os.path.join(save_dir, f"page{page}.xml"), "wb") as f:
                f.write(body)
        recs, token, err = parse_page(body)
        if err == "noRecordsMatch":
            log("  OAI: noRecordsMatch")
            return
        if err:
            raise FetchError(f"OAI error {err} for {url}")
        yield f"page {page}", recs
        url = (base + "?" + urllib.parse.urlencode(
            {"verb": "ListRecords", "resumptionToken": token})) if token else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="from_", help="OAI from= datestamp (default: meta.last_harvest)")
    ap.add_argument("--until", help="OAI until= datestamp")
    ap.add_argument("--full", action="store_true", help="harvest everything (ignore meta.last_harvest)")
    ap.add_argument("--from-dir", help="load saved OAI ListRecords XML pages instead of the network")
    ap.add_argument("--save-dir", help="also save fetched pages here (e.g. data/oai)")
    ap.add_argument("--oai-url", default=OAI_URL, help="OAI-PMH base URL (for testing)")
    ap.add_argument("--chunk", type=int, default=500, help="statements per generated SQL file")
    ap.add_argument("--remote", action="store_true", help="target remote D1 (default: --local)")
    ap.add_argument("--dry-run", action="store_true", help="parse only, do not write to D1")
    a = ap.parse_args()

    if a.from_dir:
        pages = iter_dir(a.from_dir)
        src = a.from_dir
    else:
        from_ = a.from_
        if not from_ and not a.full:
            rows = d1_query("SELECT value FROM meta WHERE key='last_harvest'", remote=a.remote)
            from_ = rows[0]["value"] if rows else None
        log(f"OAI harvest from={from_ or '(beginning)'}")
        pages = iter_live(from_, a.until, a.save_dir, base=a.oai_url)
        src = a.oai_url

    stmts, n_rec, n_del, max_ds = [], 0, 0, None
    seen = set()
    t0 = time.time()
    try:
        for label, recs in pages:
            for r in recs:
                n_rec += 1
                n_del += r["withdrawn"]
                seen.add(r["id"])
                if r["updated"] and (max_ds is None or r["updated"] > max_ds):
                    max_ds = r["updated"]
                stmts.append(upsert_sql(r))
            log(f"  {label}: {len(recs)} records (total {n_rec})")
    except FetchError as e:
        # A 403 from eprint.iacr.org is a Cloudflare block page: we never try to get around it.
        log(f"ERROR: {e}")
        if "HTTP 403" in str(e) or "HTTP 429" in str(e):
            log("eprint.iacr.org answered 403/429 (Cloudflare block or rate limit). Not retrying or "
                "working around it; "
                "nothing written, meta.last_harvest unchanged. Run from a different, well-behaved "
                "host (e.g. the cloud cron) or ask IACR to allowlist the harvester.")
        sys.exit(2)

    log(f"parsed {n_rec} records ({len(seen)} unique, {n_del} deleted) from {src}; "
        f"max datestamp {max_ds}; {time.time() - t0:.1f}s")
    if a.dry_run or not stmts:
        if not stmts:
            log("nothing to load")
        return

    d1_exec_statements(stmts, "harvest", chunk=a.chunk, remote=a.remote)
    tail = ["INSERT INTO papers_fts(papers_fts) VALUES('rebuild');"]
    if max_ds:
        tail.append("INSERT INTO meta(key,value) VALUES('last_harvest'," + sql_lit(max_ds) + ") "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value "
                    "WHERE meta.value IS NULL OR excluded.value > meta.value;")
    tail.append("INSERT INTO meta(key,value) VALUES('last_harvest_run',"
                + sql_lit(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                + ") ON CONFLICT(key) DO UPDATE SET value=excluded.value;")
    d1_exec_statements(tail, "harvest-finish", chunk=len(tail), remote=a.remote)
    stats = d1_query("SELECT count(*) AS papers, sum(withdrawn) AS withdrawn, "
                     "(SELECT value FROM meta WHERE key='last_harvest') AS last_harvest FROM papers",
                     remote=a.remote)
    log(f"done in {time.time() - t0:.0f}s: {stats[0]}")


if __name__ == "__main__":
    main()
