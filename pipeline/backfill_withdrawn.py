#!/usr/bin/env python3
"""One-off metadata backfill for withdrawn ePrint papers -> remote D1 `papers`.

OAI-PMH "deleted" records carry no metadata, but ePrint keeps a withdrawn paper's full abstract
page (title, authors + affiliations, abstract, category, license, history incl. "withdrawn").
This script reads those pages and fills the empty rows.

Where the pages come from (--source):
  wayback (default)  the latest archived copy of eprint.iacr.org/YYYY/NNNN in the Wayback Machine
                     (CDX lookup, then `id_` replay of the newest 200 capture; older captures are
                     tried if the newest doesn't parse). Nothing is requested from eprint.iacr.org.
  eprint             eprint.iacr.org/YYYY/NNNN itself (allowed by robots.txt). One client, >= 5 s
                     between requests, honest User-Agent, stops at the first 403 and backs off on
                     429. On 2026-11-10 this machine got Cloudflare's "you have been blocked" 403,
                     so the default is wayback.

If the copy predates the withdrawal (no "withdrawn" history line), `withdrawn_on` falls back to
the OAI datestamp of the deleted record (`papers.updated`).

Resumable: results go to data/withdrawn/results.jsonl (one JSON line per paper); ids already
there are skipped. `--apply` writes all parsed results to remote D1 (idempotent: only rows that
are still withdrawn are touched; FTS entries are refreshed).

  python3 -I pipeline/backfill_withdrawn.py                 # fetch + parse (resumes)
  python3 -I pipeline/backfill_withdrawn.py --apply         # write results to remote D1
  python3 -I pipeline/backfill_withdrawn.py --parse FILE    # debug the parser on a saved page
"""

import argparse
import gzip
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA_DIR, d1_exec_statements, d1_query, log, sql_lit  # noqa: E402

os.environ.setdefault("CLOUDFLARE_ACCOUNT_ID", "f1a5c2273555ad714cc5911124e671a7")  # wrangler --remote

UA = "open-cryptology-metadata/0.1 (unofficial non-commercial ePrint mirror; withdrawn-paper metadata backfill)"
OUT_DIR = os.path.join(DATA_DIR, "withdrawn")
RESULTS = os.path.join(OUT_DIR, "results.jsonl")
CDX = "https://web.archive.org/cdx/search/cdx"


class Blocked(Exception):
    pass


_last = [0.0]


def get(url, gap):
    """GET with a fixed minimum gap between requests. Returns (status, bytes)."""
    wait = _last[0] + gap - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.monotonic()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            body = r.read()
            if r.headers.get("Content-Encoding") == "gzip" or body[:2] == b"\x1f\x8b":
                body = gzip.decompress(body)
            return r.status, body
    except urllib.error.HTTPError as e:
        return e.code, b""
    except (urllib.error.URLError, OSError) as e:
        log(f"  network error {url}: {e}")
        return 0, b""


def get_patiently(url, gap, label):
    """Wayback: back off on 429/5xx/refused connections (up to ~1 h), return (status, body)."""
    delay = 60
    for _ in range(8):
        st, body = get(url, gap)
        if st in (200, 404, 403):
            return st, body
        log(f"  {label}: HTTP {st or 'conn error'}; backing off {delay}s")
        time.sleep(delay)
        delay = min(delay * 2, 900)
    raise Blocked(f"{label}: Wayback kept failing")


# --------------------------------------------------------------------------- parsing

def _text(s):
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return html.unescape(s)


def _one(pat, s, flags=re.S):
    m = re.search(pat, s, flags)
    return m.group(1) if m else None


MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def _old_date(s):
    m = re.match(r"\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})", s)
    if not m or m.group(2).lower() not in MONTHS:
        return None
    return f"{m.group(3)}-{MONTHS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}"


def parse_page(page, pid):
    """Parse an ePrint abstract page (2022+ layout, or the older pre-2022 layout).
    Returns a dict or None if this doesn't look like the paper's page."""
    if f"Paper {pid}<" in page or f"Paper {pid} " in page:
        return parse_new(page, pid)
    if f"Report {pid}<" in page and re.search(r"Category\s*/\s*Keywords", page):
        return parse_old(page, pid)
    return None


def parse_new(page, pid):
    main = _one(r'<main\b[^>]*>(.*?)</main>', page) or page
    title = _one(r'<h3 class="mb-3">(.*?)</h3>', main)
    if not title:
        return None
    authors, affs = [], []
    for name, aff in re.findall(
            r'<span class="authorName">(.*?)</span>(?:\s*<span class="affiliation">(.*?)</span>)?', main, re.S):
        authors.append(" ".join(_text(name).split()))
        affs.append(" ".join(_text(aff).split()).lstrip(", ").strip() or None)
    if not authors:  # older entries: one italic line "A, B and C"
        line = _one(r'<p class="fst-italic[^"]*">(.*?)</p>', main)
        if line:
            authors = [" ".join(x.split()) for x in re.split(r"\s+and\s+|\s*,\s*", _text(line)) if x.strip()]
            affs = [None] * len(authors)
    abstract = _one(r'<h5[^>]*>\s*Abstract\s*</h5>\s*<p[^>]*>(.*?)</p>', main)
    category = _one(r'<small class="badge category[^"]*">(.*?)</small>', main)
    lic = _one(r'<a\b[^>]*rel="license"[^>]*href="([^"]+)"', main) or \
        _one(r'<a\b[^>]*href="([^"]+)"[^>]*rel="license"', main)
    hist = re.findall(r"<dd>\s*(\d{4}-\d{2}-\d{2}):\s*([^<]+?)\s*</dd>", main)
    withdrawn_on = next((d for d, what in hist if "withdrawn" in what.lower()), None)
    received = next((d for d, what in hist if "received" in what.lower()), None)
    formats = _one(r"Available format\(s\)\s*</dt>\s*<dd>(.*?)</dd>", main) or ""
    return {
        "title": " ".join(_text(title).split()),
        "authors": authors,
        "affiliations": affs if any(affs) else None,
        "abstract": _text(abstract).strip() if abstract else None,
        "category": " ".join(_text(category).split()) if category else None,
        "license_url": html.unescape(lic) if lic else None,
        "submitted": received,
        "withdrawn_on": withdrawn_on,
        "page_says_withdrawn": "withdrawn" in formats.lower() or bool(withdrawn_on),
        "layout": "2022",
    }


OLD_CATEGORIES = {
    "applications": "Applications", "cryptographic protocols": "Cryptographic protocols",
    "foundations": "Foundations", "implementation": "Implementation",
    "secret-key cryptography": "Secret-key cryptography", "public-key cryptography": "Public-key cryptography",
    "attacks and cryptanalysis": "Attacks and cryptanalysis", "cryptanalysis": "Attacks and cryptanalysis",
}


def parse_old(page, pid):
    """Pre-2022 layout: <b>title</b><p/><i>authors</i><p/><b>Abstract: </b>...
    <b>Category / Keywords: </b>cat / kw<p/><b>Date: </b>received 18 Sep 2008, withdrawn 27 Nov 2008"""
    body = re.sub(r"\s+", " ", page)
    p = r"<p\s*/?>"
    title = _one(rf"</script>\s*<b>(.*?)</b>\s*{p}\s*<i>", body) or _one(rf"<b>([^<]{{3,}}?)</b>\s*{p}\s*<i>", body)
    authors = _one(rf"</b>\s*{p}\s*<i>(.*?)</i>", body)
    abstract = _one(rf"<b>\s*Abstract:\s*</b>(.*?){p}\s*<b>", body)
    cat = _one(rf"<b>\s*Category\s*/\s*Keywords:\s*</b>(.*?){p}", body)
    date = _one(rf"<b>\s*Date:\s*</b>(.*?){p}", body) or ""
    if not title or not authors:
        return None
    names = [" ".join(a.split()) for a in re.split(r"\s+and\s+|\s*,\s*", _text(authors)) if a.strip()]
    rec = re.search(r"received\s+([^,]+)", date)
    wd = re.search(r"withdrawn\s+([^,]+)", date)
    lic = _one(r'<a\b[^>]*rel="license"[^>]*href="([^"]+)"', page)
    category = " ".join(_text(cat).split("/")[0].split()).lower() if cat else ""
    return {
        "title": " ".join(_text(title).split()),
        "authors": names,
        "affiliations": None,
        "abstract": " ".join(_text(abstract).split()) if abstract else None,
        "category": OLD_CATEGORIES.get(category) or (category.capitalize() or None),
        "license_url": html.unescape(lic) if lic else None,
        "submitted": _old_date(rec.group(1)) if rec else None,
        "withdrawn_on": _old_date(wd.group(1)) if wd else None,
        "page_says_withdrawn": bool(wd) or "-- withdrawn --" in body,
        "layout": "old",
    }


# --------------------------------------------------------------------------- fetching

def wayback_captures(pid, gap):
    q = urllib.parse.urlencode([("url", f"eprint.iacr.org/{pid}"), ("fl", "timestamp,original,digest"),
                                ("filter", "statuscode:200"), ("filter", "mimetype:text/html"),
                                ("output", "json")])
    st, body = get_patiently(f"{CDX}?{q}", gap, f"cdx {pid}")
    if st != 200:
        return []
    try:
        rows = json.loads(body or b"[]")[1:]
    except ValueError:
        return []
    seen, out = set(), []
    for ts, orig, digest in sorted(rows, reverse=True):  # newest first, one per distinct page body
        if digest in seen:
            continue
        seen.add(digest)
        out.append((ts, orig))
    return out


def fetch_wayback(pid, gap):
    caps = wayback_captures(pid, gap)
    if not caps:
        return {"id": pid, "ok": False, "error": "no wayback capture"}
    for ts, orig in caps[:4]:
        url = f"https://web.archive.org/web/{ts}id_/{orig}"
        st, body = get_patiently(url, gap, f"page {pid}@{ts}")
        if st != 200:
            continue
        rec = parse_page(body.decode("utf-8", "replace"), pid)
        if rec and rec["title"]:
            return {"id": pid, "ok": True, "via": "wayback", "url": url,
                    "captured_at": f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}", **rec}
    return {"id": pid, "ok": False, "error": f"no parsable capture among {min(4, len(caps))}"}


def fetch_eprint(pid, gap):
    st, body = get(f"https://eprint.iacr.org/{pid}", gap)
    if st == 403:
        raise Blocked("eprint.iacr.org answered 403; stopping (do not work around it)")
    if st == 429:
        log("  429 from eprint.iacr.org; sleeping 10 min")
        time.sleep(600)
        st, body = get(f"https://eprint.iacr.org/{pid}", gap)
        if st in (403, 429):
            raise Blocked(f"eprint.iacr.org still answers {st}; stopping")
    if st != 200:
        return {"id": pid, "ok": False, "error": f"HTTP {st}"}
    rec = parse_page(body.decode("utf-8", "replace"), pid)
    if not rec:
        return {"id": pid, "ok": False, "error": "unparsable"}
    return {"id": pid, "ok": True, "via": "eprint", "url": f"https://eprint.iacr.org/{pid}",
            "captured_at": time.strftime("%Y-%m-%d"), **rec}


# --------------------------------------------------------------------------- apply

def license_code(url):
    if not url:
        return None
    u = url.strip().lower()
    if "publicdomain/zero" in u:
        return "CC0"
    m = re.search(r"creativecommons\.org/licenses/([a-z-]+)/", u)
    code = "CC " + m.group(1).upper() if m else None
    return code if code in ("CC BY", "CC BY-SA", "CC BY-NC", "CC BY-NC-SA", "CC BY-NC-ND") else None


def apply(results):
    rows = {r["id"]: r for r in d1_query("SELECT id, updated FROM papers WHERE withdrawn = 1", remote=True)}
    stmts = []
    n = 0
    for pid, rec in results.items():
        if pid not in rows:
            continue
        upd = rows[pid]["updated"]
        withdrawn_on = rec.get("withdrawn_on") if rec.get("ok") else None
        if not withdrawn_on and upd:
            withdrawn_on = upd[:10]  # OAI datestamp of the deleted record
        fts_del = ("INSERT INTO papers_fts(papers_fts, rowid, id, title, authors, abstract) "
                   f"SELECT 'delete', rowid, id, title, authors, abstract FROM papers WHERE id = {sql_lit(pid)};")
        fts_ins = ("INSERT INTO papers_fts(rowid, id, title, authors, abstract) "
                   f"SELECT rowid, id, title, authors, abstract FROM papers WHERE id = {sql_lit(pid)};")
        if rec.get("ok"):
            lic = rec.get("license_url")
            sets = {
                "title": rec["title"],
                "authors": json.dumps(rec["authors"], ensure_ascii=False),
                "affiliations": json.dumps(rec["affiliations"], ensure_ascii=False) if rec.get("affiliations") else None,
                "abstract": rec.get("abstract"),
                "category": rec.get("category"),
                "license_url": lic,
                "license_code": license_code(lic),
                "submitted": rec.get("submitted"),
                "withdrawn_on": withdrawn_on,
            }
            # Never overwrite non-empty metadata with empty values.
            assign = ", ".join(
                f"{k} = COALESCE({sql_lit(v)}, {k})" if k not in ("title",) else f"{k} = CASE WHEN {sql_lit(v)} <> '' THEN {sql_lit(v)} ELSE {k} END"
                for k, v in sets.items())
            stmts += [fts_del, f"UPDATE papers SET {assign} WHERE id = {sql_lit(pid)} AND withdrawn = 1;", fts_ins]
            n += 1
        elif withdrawn_on:
            stmts.append(f"UPDATE papers SET withdrawn_on = COALESCE(withdrawn_on, {sql_lit(withdrawn_on)}) "
                         f"WHERE id = {sql_lit(pid)} AND withdrawn = 1;")
    # withdrawn rows with no result at all still get a withdrawal date from the OAI datestamp
    for pid, r in rows.items():
        if pid not in results and r["updated"]:
            stmts.append(f"UPDATE papers SET withdrawn_on = COALESCE(withdrawn_on, {sql_lit(r['updated'][:10])}) "
                         f"WHERE id = {sql_lit(pid)} AND withdrawn = 1;")
    log(f"applying metadata for {n} papers ({len(stmts)} statements)")
    d1_exec_statements(stmts, "withdrawn-apply", chunk=600, remote=True)


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["wayback", "eprint"], default="wayback")
    ap.add_argument("--gap", type=float, default=None, help="seconds between requests (wayback 3, eprint 5)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--ids", help="comma list of ids (default: all withdrawn papers without a title)")
    ap.add_argument("--retry-failed", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--parse", help="parse a saved page and print the result")
    a = ap.parse_args()

    if a.parse:
        raw = open(a.parse, "rb").read()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        pid = a.ids or re.search(r"Paper (\d{4}/\d+)", raw.decode("utf-8", "replace")).group(1)
        print(json.dumps(parse_page(raw.decode("utf-8", "replace"), pid), indent=2, ensure_ascii=False))
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    results = {}
    if os.path.exists(RESULTS):
        for line in open(RESULTS, encoding="utf-8"):
            j = json.loads(line)
            if j.get("ok") or j["id"] not in results:
                results[j["id"]] = j

    if a.apply:
        apply(results)
        return

    gap = a.gap or (5.0 if a.source == "eprint" else 3.0)
    if a.ids:
        ids = a.ids.split(",")
    else:
        ids = [r["id"] for r in d1_query(
            "SELECT id FROM papers WHERE withdrawn = 1 AND title = '' ORDER BY year, num", remote=True)]
    todo = [i for i in ids if i not in results or (a.retry_failed and not results[i].get("ok"))]
    if a.limit:
        todo = todo[:a.limit]
    log(f"{len(ids)} withdrawn papers, {len(todo)} to fetch via {a.source} (gap {gap}s)")
    ok = fail = 0
    with open(RESULTS, "a", encoding="utf-8") as out:
        for i, pid in enumerate(todo, 1):
            try:
                rec = fetch_wayback(pid, gap) if a.source == "wayback" else fetch_eprint(pid, gap)
            except Blocked as e:
                log(f"STOP: {e}")
                break
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out.flush()
            ok += rec["ok"]
            fail += not rec["ok"]
            if i % 25 == 0 or not rec["ok"]:
                log(f"{time.strftime('%H:%M:%S')} {i}/{len(todo)} ok={ok} fail={fail}"
                    + ("" if rec["ok"] else f"  {pid}: {rec.get('error')}"))
    log(f"done: ok={ok} fail={fail}")


if __name__ == "__main__":
    main()
