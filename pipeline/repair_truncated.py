#!/usr/bin/env python3
"""Repair papers whose PDF is a truncated Wayback capture (cut off at exactly 1 MiB when it was
crawled; see worker/src/pdfcheck.ts). Before the copy helpers checked for a complete file, ~2,000
such captures were stored as versions, and ~930 papers ended up with one as their default PDF.

Stages (state in data/repair-truncated/, gitignored):

  plan      Dry run; changes nothing in D1 or R2. Lists the truncated versions (size = 1 MiB) and
            the affected papers (default PDF is one of them). Checks each truncated object in R2
            (helper /check) to confirm it really is cut off. Then, per affected paper, finds a
            complete replacement, in this order:
              1. a version we already hold (newest first), confirmed complete by /check;
              2. the GitHub community mirror copy (probed: fetched and checked, not stored);
              3. other Wayback captures with a different digest (newest first, up to
                 --max-wayback per paper; probed one at a time, >= 3 s apart).
            Papers with none go back to /missing.
            -> plan.json, report.md
  apply     Carry out plan.json: store the probed replacements (helper /copy), then in D1 point
            each affected paper at its replacement (or clear pdf_* so it shows in /missing) and
            delete the truncated `versions` rows. Each paper update only applies if pdf_key is
            still the truncated key the plan saw. Nothing is deleted from R2.
            -> apply-results.jsonl, r2-delete-keys.txt
  delete-r2 Delete the truncated objects listed in r2-delete-keys.txt from R2, skipping any key a
            paper or version still points to. Requires --confirm; meant to run only after the
            maintainer has read report.md.

  VERSIONS_DIR=<dir with .versions-key and cdx-rows.json> python3 -I pipeline/repair_truncated.py plan
  VERSIONS_DIR=... python3 -I pipeline/repair_truncated.py apply
  VERSIONS_DIR=... python3 -I pipeline/repair_truncated.py delete-r2 --confirm

Uses the helper Worker open-cryptology-versions (versions-worker/), which must include /check and
/copy probe support. Never fetches from eprint.iacr.org.
"""

import argparse
import collections
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import discover_versions as dv  # noqa: E402  (helper(), remote(), stamp_of(), CDX rows, account id)
from common import DATA_DIR, R2_BUCKET, WORKER_DIR, d1_exec_statements, log, sql_lit  # noqa: E402

ONE_MIB = 1024 * 1024
RDIR = os.path.join(DATA_DIR, "repair-truncated")
PLAN = os.path.join(RDIR, "plan.json")
REPORT = os.path.join(RDIR, "report.md")
APPLY_OUT = os.path.join(RDIR, "apply-results.jsonl")
DELETE_KEYS = os.path.join(RDIR, "r2-delete-keys.txt")
WB_GAP = 3.0


def chunks(xs, n):
    return [xs[i:i + n] for i in range(0, len(xs), n)]


def in_list(ids):
    return ",".join(sql_lit(i) for i in ids)


def check_keys(items):
    """[{id, key}] -> {key: /check result}, 20 per request."""
    out = {}
    for batch in chunks(items, 20):
        for r in dv.helper("/check", batch):
            out[r["key"]] = r
    return out


class Prober:
    """Fetch-and-check (no store) through the helper, politely for Wayback."""

    def __init__(self):
        self.last = 0.0

    def __call__(self, pid, cand):
        if cand["kind"] == "wayback":
            wait = self.last + WB_GAP - time.monotonic()
            if wait > 0:
                time.sleep(wait)
        for attempt in range(4):
            r = dv.helper("/copy", [{"id": pid, "url": cand["url"], "key": cand["key"], "probe": True}])[0]
            if cand["kind"] == "wayback":
                self.last = time.monotonic()
            if r.get("status") in (429, 503) or (r.get("status") is None and "helper call failed" in str(r.get("error"))):
                log(f"  {pid}: {r.get('status') or r.get('error')}; pausing 120 s")
                time.sleep(120)
                continue
            return r
        return r


# --------------------------------------------------------------------------- plan

def cmd_plan(a):
    os.makedirs(RDIR, exist_ok=True)
    bad = dv.remote(f"SELECT id, paper_id, r2_key, sha1, size, source, source_url, captured_at FROM versions WHERE size = {ONE_MIB}")
    bad_keys = {v["r2_key"] for v in bad}
    affected = dv.remote(
        "SELECT id, withdrawn, updated, pdf_key, pdf_size, pdf_source, pdf_source_date FROM papers "
        f"WHERE pdf_size = {ONE_MIB} OR pdf_key IN (SELECT r2_key FROM versions WHERE size = {ONE_MIB})")
    log(f"{len(bad)} truncated versions ({len({v['paper_id'] for v in bad})} papers); "
        f"{len(affected)} papers serve one as their default PDF")

    # 1. Confirm the 1 MiB objects really are cut off (byte check, ignoring the size rule).
    bad_check = check_keys([{"id": v["paper_id"], "key": v["r2_key"]} for v in bad]
                           + [{"id": p["id"], "key": p["pdf_key"]} for p in affected if p["pdf_key"] not in bad_keys])
    cut = collections.Counter(
        "missing in R2" if not r.get("ok") else ("cut off: " + r["problem"].split(":")[0]) if r.get("problem") else "has %%EOF (complete?)"
        for r in bad_check.values())
    log(f"truncated objects: {dict(cut)}")

    ids = [p["id"] for p in affected]
    held = collections.defaultdict(list)
    gh = {}
    for batch in chunks(ids, 200):
        for v in dv.remote(f"SELECT paper_id, r2_key, sha256, sha1, size, source, source_url, captured_at FROM versions "
                           f"WHERE paper_id IN ({in_list(batch)}) AND size IS NOT {ONE_MIB} ORDER BY captured_at DESC, id DESC"):
            held[v["paper_id"]].append(v)
        for s in dv.remote(f"SELECT paper_id, url, captured_at FROM sources WHERE kind = 'github-mirror' AND paper_id IN ({in_list(batch)})"):
            gh[s["paper_id"]] = s

    # 2. Held versions, newest first: check them in rounds (one candidate per paper per round).
    choice, tried = {}, collections.defaultdict(list)
    rnd = 0
    while True:
        todo = [(pid, held[pid][rnd]) for pid in ids if pid not in choice and len(held[pid]) > rnd]
        if not todo:
            break
        res = check_keys([{"id": pid, "key": v["r2_key"]} for pid, v in todo])
        for pid, v in todo:
            r = res.get(v["r2_key"], {})
            tried[pid].append({"kind": "held", "key": v["r2_key"], "complete": bool(r.get("complete")),
                               "problem": r.get("problem") or r.get("error")})
            if r.get("complete"):
                choice[pid] = {"action": "repoint", "key": v["r2_key"], "sha256": v["sha256"], "size": v["size"],
                               "source": v["source"], "url": v["source_url"], "captured_at": v["captured_at"], "pages": r.get("pages")}
        rnd += 1
    log(f"held versions: {len(choice)} papers have a complete one")

    # 3./4. Fetch candidates for the rest: GitHub, then other Wayback digests.
    rest = [pid for pid in ids if pid not in choice]
    cdx = collections.defaultdict(dict)
    if rest:
        if not os.path.exists(dv.CDX_ROWS):
            sys.exit(f"{dv.CDX_ROWS} not found (set VERSIONS_DIR, or run discover_versions.py list)")
        want = {(int(pid[:4]), int(pid[5:])): pid for pid in rest}
        known_bad_digests = {v["sha1"] for v in bad if v["sha1"]}
        for original, ts, length, mime, status, digest in json.load(open(dv.CDX_ROWS)):
            m = dv.PDF_RE.match(original)
            if not m or mime != "application/pdf" or status != "200" or digest in known_bad_digests:
                continue
            pid = want.get((int(m.group(1)), int(m.group(2))))
            if pid and (digest not in cdx[pid] or ts > cdx[pid][digest][0]):
                cdx[pid][digest] = (ts, original)
    probe = Prober()
    for n, pid in enumerate(rest, 1):
        held_sha1 = {v["sha1"] for v in held[pid] if v["sha1"]}
        cands = []
        if pid in gh and gh[pid]["captured_at"]:
            cands.append({"kind": "github-mirror", "url": gh[pid]["url"], "captured_at": gh[pid]["captured_at"],
                          "key": f"pdf/{pid}/{dv.stamp_of(gh[pid]['captured_at'])}.pdf"})
        wb = sorted(((ts, orig, d) for d, (ts, orig) in cdx[pid].items() if d not in held_sha1), reverse=True)
        for ts, orig, d in wb[:a.max_wayback]:
            cands.append({"kind": "wayback", "url": f"https://web.archive.org/web/{ts}id_/{orig}", "captured_at": dv.ts_iso(ts),
                          "key": f"pdf/{pid}/{dv.stamp_of(ts)}.pdf", "digest": d})
        for c in cands:
            if c["kind"] == "github-mirror" and any(v["source"] == "github-mirror" for v in held[pid]):
                continue  # the GitHub copy is already a held version, checked above
            r = probe(pid, c)
            tried[pid].append({"kind": c["kind"], "url": c["url"], "complete": bool(r.get("ok")),
                               "problem": r.get("error"), "size": r.get("size")})
            if r.get("ok"):
                choice[pid] = {"action": "fetch", "kind": c["kind"], "key": c["key"], "url": c["url"],
                               "captured_at": c["captured_at"], "sha256": r.get("sha256"), "sha1": r.get("sha1"),
                               "size": r.get("size"), "pages": r.get("pages"), "source": c["kind"]}
                break
        log(f"  fetch candidates {n}/{len(rest)} {pid}: {choice.get(pid, {}).get('kind', 'none')} "
            f"({len(cands)} candidates)")

    papers = []
    for p in affected:
        c = choice.get(p["id"], {"action": "missing"})
        stale = 0
        if c["action"] != "missing" and not p["withdrawn"] and p["updated"] and c["captured_at"] < p["updated"]:
            stale = 1
        papers.append({**p, **{"target": c, "action": c["action"], "stale": stale, "tried": tried[p["id"]]}})
    plan = {"created": dv.now_iso(), "bad_versions": bad, "bad_check": bad_check, "papers": papers}
    with open(PLAN, "w") as f:
        json.dump(plan, f, indent=1)
    write_report(plan)
    log(f"plan -> {PLAN}\nreport -> {REPORT}")


def write_report(plan):
    papers, bad = plan["papers"], plan["bad_versions"]
    by = collections.Counter(p["action"] for p in papers)
    fetch_kind = collections.Counter(p["target"].get("kind") for p in papers if p["action"] == "fetch")
    src = collections.Counter(p["target"]["source"] for p in papers if p["action"] == "repoint")
    older = sum(1 for p in papers if p["action"] != "missing" and p["pdf_source_date"] and p["target"]["captured_at"] < p["pdf_source_date"])
    stale = sum(p["stale"] for p in papers)
    stale_before = sum(1 for p in papers if not p["withdrawn"] and p["updated"] and p["pdf_source_date"] and p["pdf_source_date"] < p["updated"])
    cut = collections.Counter(
        "missing from R2" if not r.get("ok") else "cut off (no %%EOF / startxref)" if r.get("problem") else "ends properly"
        for r in plan["bad_check"].values())
    other_bad = len({v["paper_id"] for v in bad}) - len({p["id"] for p in papers})
    missing = [p for p in papers if p["action"] == "missing"]
    lines = [
        "# Truncated Wayback PDFs: repair plan (dry run)", "",
        f"Plan made {plan['created']}. Nothing has been changed yet.", "",
        "## What is broken", "",
        f"- {len(bad)} stored versions are exactly 1 MiB (1,048,576 bytes), across {len({v['paper_id'] for v in bad})} papers.",
        f"- Checked in R2: {', '.join(f'{n} {k}' for k, n in cut.most_common())}.",
        f"- {len(papers)} papers serve one of them as their default PDF "
        f"({sum(p['withdrawn'] for p in papers)} of them withdrawn). The other {other_bad} papers only have one in their version list.", "",
        "## Proposed fix for the papers that serve a truncated file", "",
        "| outcome | papers |", "|---|---:|",
        f"| point at a complete version we already hold | {by['repoint']} |",
        f"| fetch a complete copy (GitHub mirror) | {fetch_kind['github-mirror']} |",
        f"| fetch a complete copy (another Wayback capture) | {fetch_kind['wayback']} |",
        f"| **no complete copy: clear the PDF, back to /missing** | **{by['missing']}** |", "",
        f"Held versions used, by source: {', '.join(f'{k} {n}' for k, n in src.most_common()) or 'none'}.",
        f"{older} of the repaired papers get a copy captured earlier than the truncated one; "
        f"{stale} would be marked 'may be outdated' (vs {stale_before} of these papers today).", "",
        "In D1 (`apply`): each paper's `pdf_*` columns move to the replacement (only if `pdf_key` is still the truncated key), "
        f"and all {len(bad)} truncated `versions` rows are deleted, so they leave the version lists too.", "",
        "## Needs your approval separately: deleting from R2", "",
        f"`delete-r2 --confirm` would delete the {len(bad)} truncated objects "
        f"(~{len(bad) * ONE_MIB / 1e9:.1f} GB) once nothing in D1 points to them. Nothing is deleted before you approve it.", "",
    ]
    if missing:
        lines += ["## Papers that go back to /missing", ""]
        for p in missing:
            why = "; ".join(f"{t['kind']}: {t['problem'] or 'ok'}" for t in p["tried"]) or "no other copy known"
            lines.append(f"- [{p['id']}](https://opencryptology.org/{p['id']}){' (withdrawn)' if p['withdrawn'] else ''}: {why}")
        lines.append("")
    with open(REPORT, "w") as f:
        f.write("\n".join(lines))


# --------------------------------------------------------------------------- apply

def cmd_apply(a):
    plan = json.load(open(PLAN))
    stmts, done = [], {}
    if os.path.exists(APPLY_OUT):
        done = {j["id"]: j for j in dv.read_jsonl(APPLY_OUT) if j.get("ok")}
    out = open(APPLY_OUT, "a")
    for p in plan["papers"]:
        t = p["target"]
        if p["action"] != "fetch" or p["id"] in done:
            continue
        r = dv.helper("/copy", [{"id": p["id"], "url": t["url"], "key": t["key"]}])[0]
        out.write(json.dumps({"id": p["id"], **r}) + "\n")
        out.flush()
        if not r.get("ok"):
            log(f"  {p['id']}: copy failed ({r.get('error')}); this paper is left as it is")
            continue
        done[p["id"]] = r
        stmts.append(
            "INSERT OR IGNORE INTO versions (paper_id, stamp, r2_key, sha256, sha1, size, source, source_url, captured_at, added_at) "
            f"VALUES ({sql_lit(p['id'])}, {sql_lit(dv.stamp_of(t['captured_at']))}, {sql_lit(t['key'])}, {sql_lit(r['sha256'])}, "
            f"{sql_lit(r['sha1'])}, {sql_lit(r['size'])}, {sql_lit(t['kind'])}, {sql_lit(t['url'])}, "
            f"{sql_lit(t['captured_at'])}, {sql_lit(dv.now_iso())});")
        if a.wb_gap and t["kind"] == "wayback":
            time.sleep(a.wb_gap)
    out.close()
    for j in dv.read_jsonl(APPLY_OUT):  # earlier runs' copies (resume)
        if j.get("ok"):
            done.setdefault(j["id"], j)

    for p in plan["papers"]:
        t, pid, old = p["target"], sql_lit(p["id"]), sql_lit(p["pdf_key"])
        if p["action"] == "missing":
            stmts.append("UPDATE papers SET pdf_key = NULL, pdf_sha256 = NULL, pdf_size = NULL, pdf_source = NULL, "
                         f"pdf_source_date = NULL, pdf_maybe_stale = 0 WHERE id = {pid} AND pdf_key = {old};")
            continue
        if p["action"] == "fetch" and p["id"] not in done:
            continue
        # The version row by sha256 (a fetched copy whose content we already held keeps that row's key).
        where = (f"r2_key = {sql_lit(t['key'])}" if p["action"] == "repoint"
                 else f"sha256 = {sql_lit(done[p['id']]['sha256'])}")
        stmts.append(
            "UPDATE papers SET pdf_key = v.r2_key, pdf_sha256 = v.sha256, pdf_size = v.size, pdf_source = v.source, "
            "pdf_source_date = v.captured_at, pdf_maybe_stale = CASE WHEN papers.withdrawn = 0 AND papers.updated IS NOT NULL "
            "AND v.captured_at < papers.updated THEN 1 ELSE 0 END "
            f"FROM (SELECT * FROM versions WHERE paper_id = {pid} AND {where} LIMIT 1) AS v "
            f"WHERE papers.id = {pid} AND papers.pdf_key = {old};")
    bad_keys = sorted({v["r2_key"] for v in plan["bad_versions"]}
                      | {p["pdf_key"] for p in plan["papers"] if p["pdf_size"] == ONE_MIB})
    for batch in chunks(bad_keys, 200):
        stmts.append(f"DELETE FROM versions WHERE size = {ONE_MIB} AND r2_key IN ({in_list(batch)}) "
                     "AND r2_key NOT IN (SELECT pdf_key FROM papers WHERE pdf_key IS NOT NULL);")
    log(f"applying {len(stmts)} D1 statements")
    d1_exec_statements(stmts, "repair-truncated", chunk=1000, remote=True)
    with open(DELETE_KEYS, "w") as f:
        f.writelines(k + "\n" for k in bad_keys)
    left = dv.remote(f"SELECT count(*) AS n FROM papers WHERE pdf_size = {ONE_MIB}")[0]["n"]
    log(f"done; papers still serving a 1 MiB file: {left}. R2 keys to delete (after approval): {DELETE_KEYS}")


# --------------------------------------------------------------------------- delete-r2

def cmd_delete_r2(a):
    if not a.confirm:
        sys.exit("delete-r2 deletes objects from R2 permanently; re-run with --confirm once the maintainer has approved.")
    keys = open(DELETE_KEYS).read().split()
    still = set()
    for batch in chunks(keys, 200):
        still |= {r["k"] for r in dv.remote(
            f"SELECT pdf_key AS k FROM papers WHERE pdf_key IN ({in_list(batch)}) "
            f"UNION SELECT r2_key FROM versions WHERE r2_key IN ({in_list(batch)})")}
    todo = [k for k in keys if k not in still]
    log(f"deleting {len(todo)} objects ({len(still)} skipped: still referenced in D1)")
    for i, k in enumerate(todo, 1):
        r = subprocess.run(["npx", "--no-install", "wrangler", "r2", "object", "delete", f"{R2_BUCKET}/{k}", "--remote"],
                           cwd=WORKER_DIR, capture_output=True, text=True)
        if r.returncode != 0:
            log(f"  {k}: delete failed: {(r.stderr or r.stdout)[-300:]}")
        if i % 100 == 0:
            log(f"  {i}/{len(todo)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", choices=["plan", "apply", "delete-r2"])
    ap.add_argument("--max-wayback", type=int, default=4, help="plan: other Wayback captures to try per paper")
    ap.add_argument("--wb-gap", type=float, default=WB_GAP, help="apply: seconds between Wayback copies")
    ap.add_argument("--confirm", action="store_true", help="delete-r2: really delete")
    a = ap.parse_args()
    {"plan": cmd_plan, "apply": cmd_apply, "delete-r2": cmd_delete_r2}[a.stage](a)


if __name__ == "__main__":
    main()
