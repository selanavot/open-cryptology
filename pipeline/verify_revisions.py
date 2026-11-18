"""Reconcile candidate uploads with revision-specific hashes. Run after each metadata harvest."""
import argparse
import datetime
import hashlib
import os
import re
import sys
import time
import urllib.error
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harvest_remote import D1, DEFAULT_ACCOUNT, DEFAULT_DB, USER_AGENT

MIRROR = "https://eprint.iacr.asia"
LIMIT = 30 * 1024 * 1024


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.hrefs.append((dict(attrs).get("href") or "").strip())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(path, limit):
    req = urllib.request.Request(MIRROR + path, headers={"User-Agent": USER_AGENT})
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=15) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("response exceeds limit")
    return data


def mirror_policy():
    body = fetch("/robots.txt", 512 * 1024).decode("utf-8-sig")
    if not any(line.lower().lstrip().startswith("user-agent:") for line in body.splitlines()):
        raise ValueError("unrecognized robots.txt")
    policy = urllib.robotparser.RobotFileParser()
    policy.parse(body.splitlines())
    return policy


def observe(pid, policy):
    def permitted_fetch(path, limit):
        if not policy.can_fetch(USER_AGENT, MIRROR + path):
            raise PermissionError(f"mirror robots.txt disallows {path}")
        return fetch(path, limit)

    # The version list identifies the publisher's latest revision even before OAI catches up.
    prefix = "/archive/" + pid + "/"
    index = Links()
    index.feed(permitted_fetch("/archive/versions/" + pid, 1024 * 1024).decode())
    stamps = [h[len(prefix):] for h in index.hrefs
              if re.fullmatch(re.escape(prefix) + r"[0-9]{8}:[0-9]{6}", h)]
    if not stamps:
        raise ValueError("no dated revisions")
    date = datetime.datetime.strptime(max(stamps), "%Y%m%d:%H%M%S")
    time.sleep(3)
    page = permitted_fetch(prefix + date.strftime("%Y%m%d:%H%M%S"), 1024 * 1024)
    links = Links()
    links.feed(page.decode())
    files = {h for h in links.hrefs if re.fullmatch(re.escape(prefix) + r"[0-9]+\.pdf", h)}
    if len(files) != 1:
        raise ValueError("no unambiguous archived PDF")
    time.sleep(3)
    data = permitted_fetch(files.pop(), LIMIT)
    if not data.startswith(b"%PDF-"):
        raise ValueError("archive did not return a PDF")
    return date.strftime("%Y-%m-%dT%H:%M:%SZ"), hashlib.sha256(data).hexdigest()


def record(db, pid, revision, sha):
    db.query("INSERT INTO verified_revisions VALUES(?,?,?) ON CONFLICT DO NOTHING", [pid, revision, sha])
    stored = db.query("SELECT sha256 FROM verified_revisions WHERE paper_id=? AND revision=?", [pid, revision])
    if stored[0]["sha256"] != sha:
        raise ValueError("conflicting hash for an immutable revision")


def reconcile(db):
    # Retryable steps: a candidate only leaves the queue after its version row exists.
    db.query("""INSERT OR IGNORE INTO versions(paper_id,stamp,r2_key,sha256,size,source,captured_at,added_at)
        SELECT u.paper_id,u.sha256,u.r2_key,u.sha256,u.size,'upload',u.created_at,u.created_at
        FROM uploads u WHERE u.status='candidate' AND EXISTS (
          SELECT 1 FROM verified_revisions r WHERE r.paper_id=u.paper_id AND r.sha256=u.sha256)""")
    db.query("""UPDATE papers AS p SET (pdf_key,pdf_sha256,pdf_size,pdf_source,pdf_source_date,pdf_maybe_stale)
        =(v.r2_key,v.sha256,v.size,v.source,v.captured_at,0)
        FROM verified_revisions r JOIN versions v ON v.paper_id=r.paper_id AND v.sha256=r.sha256
        WHERE p.id=r.paper_id AND p.withdrawn=0 AND (p.updated=r.revision OR
          (p.updated<r.revision AND EXISTS (SELECT 1 FROM revision_heads h
           WHERE h.paper_id=p.id AND h.revision=r.revision)))
        AND (p.pdf_sha256 IS NOT v.sha256 OR p.pdf_maybe_stale!=0)
        AND NOT EXISTS (SELECT 1 FROM verified_revisions later
                        WHERE later.paper_id=r.paper_id AND later.revision>r.revision)""")
    db.query("""UPDATE uploads AS u SET status='accepted' WHERE status='candidate' AND EXISTS
        (SELECT 1 FROM versions v JOIN verified_revisions r ON r.paper_id=v.paper_id AND r.sha256=v.sha256
         WHERE v.paper_id=u.paper_id AND v.sha256=u.sha256)""")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attest", nargs=3, metavar=("PAPER", "UTC_REVISION", "SHA256"))
    args = parser.parse_args()
    db = D1(os.environ["CLOUDFLARE_API_TOKEN"], os.getenv("CF_ACCOUNT_ID") or DEFAULT_ACCOUNT,
            os.getenv("D1_DATABASE_ID") or DEFAULT_DB)
    if args.attest:
        pid, revision, sha = args.attest
        datetime.datetime.strptime(revision, "%Y-%m-%dT%H:%M:%SZ")
        if not re.fullmatch(r"\d{4}/\d{3,6}", pid) or not re.fullmatch(r"[0-9a-f]{64}", sha):
            parser.error("invalid paper ID or hash")
        record(db, pid, revision, sha)
    else:
        rows = db.query("""SELECT DISTINCT p.id,p.updated FROM uploads u JOIN papers p ON p.id=u.paper_id
            LEFT JOIN revision_checks c ON c.paper_id=p.id
            WHERE u.status='candidate' AND p.withdrawn=0 AND p.updated IS NOT NULL
            AND (c.checked_at IS NULL OR c.checked_at < datetime('now','-8 hours'))
            ORDER BY coalesce(c.checked_at,''),p.id LIMIT 10""")
        if rows:
            try:
                policy = mirror_policy()
                if not policy.can_fetch(USER_AGENT, MIRROR + "/archive/versions/" + rows[0]["id"]):
                    raise PermissionError("mirror robots.txt disallows the revision index")
            except (ValueError, OSError) as err:
                print(f"Mirror checks deferred: {err}", file=sys.stderr)
                rows = []
        for row in rows:
            pid, revision = row["id"], row["updated"]
            db.query("INSERT OR REPLACE INTO revision_checks VALUES(?,CURRENT_TIMESTAMP)", [pid])
            try:
                revision, sha = observe(pid, policy)
            except (ValueError, OSError) as err:
                print(f"Revision check deferred for {pid}: {err}", file=sys.stderr)
                if isinstance(err, urllib.error.HTTPError) and err.code in (403, 429):
                    break
            else:
                record(db, pid, revision, sha)
                db.query("""INSERT INTO revision_heads VALUES(?,?) ON CONFLICT(paper_id) DO UPDATE
                            SET revision=excluded.revision WHERE excluded.revision>revision_heads.revision""",
                         [pid, revision])
            time.sleep(3)
    reconcile(db)


if __name__ == "__main__":
    main()
