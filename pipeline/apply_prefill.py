"""Record prefill_r2.py results in the remote D1 `papers` table (pdf_* columns), in chunks.

Run after D1's daily write quota has room (free tier: 100k row writes/day; ~1 write per paper).
  python3 -I pipeline/apply_prefill.py data/prefill/results.jsonl [--dry-run]
Only papers whose pdf_key is still NULL are touched; re-running is harmless.
"""

import json
import os
import subprocess
import sys
import tempfile

WORKER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "worker")
CHUNK = 2000


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main(path, dry=False):
    best = {}
    for line in open(path):
        j = json.loads(line)
        if j.get("ok"):
            best[j["id"]] = j
    stmts = [
        "UPDATE papers SET pdf_key={}, pdf_sha256={}, pdf_size={}, pdf_source={}, pdf_source_date={}, "
        "pdf_maybe_stale={} WHERE id={} AND pdf_key IS NULL;".format(
            q(f"pdf/{j['id']}.pdf"), q(j["sha256"]), q(j["size"]), q(j["source"]), q(j["captured_at"]),
            q(j["stale"]), q(j["id"]))
        for j in best.values()
    ]
    print(f"{len(stmts)} updates in {(len(stmts) + CHUNK - 1) // CHUNK} chunks", flush=True)
    if dry:
        return
    env = dict(os.environ, CLOUDFLARE_ACCOUNT_ID="f1a5c2273555ad714cc5911124e671a7")
    for i in range(0, len(stmts), CHUNK):
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
            f.write("\n".join(stmts[i:i + CHUNK]))
        r = subprocess.run(["npx", "--no-install", "wrangler", "d1", "execute", "DB", "--remote", "-y", "--file", f.name],
                           cwd=WORKER_DIR, env=env, capture_output=True, text=True)
        os.unlink(f.name)
        ok = r.returncode == 0 and '"success": true' in r.stdout
        print(f"chunk {i // CHUNK + 1}: {'ok' if ok else 'FAILED'}", flush=True)
        if not ok:
            print((r.stdout + r.stderr)[-1500:])
            sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1], "--dry-run" in sys.argv)
