"""Drive the temporary prefill Worker (prefill-worker/): send it batches of (id, source URL) and
let it copy PDFs into R2 inside Cloudflare. The laptop only sends small JSON requests.

  python3 -I pipeline/prefill_via_worker.py data/prefill/candidates.json data/prefill/results.jsonl

Resumable: ids already "ok" in results.jsonl are skipped. Source choice per paper: a capture
at/after the paper's last ePrint update wins (GitHub first), else the newest capture; on failure
the next source is tried. GitHub batches run 6 in parallel; Wayback is one paper every 3 s.
"""

import json
import os
import queue
import sys
import threading
import time
import urllib.request

WORKER = "https://open-cryptology-prefill.opencryptology.workers.dev/prefill"
KEY_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "prefill", ".prefill-key")
GH_BATCH, GH_THREADS, WB_GAP = 20, 6, 3.0


def call(items):
    req = urllib.request.Request(WORKER, data=json.dumps(items).encode(), method="POST", headers={
        "x-prefill-key": open(KEY_FILE).read().strip(), "content-type": "application/json",
        "user-agent": "open-cryptology-prefill-driver/0.1"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(5 * 2 ** attempt)
    return [{"id": it["id"], "ok": False, "error": f"worker call failed: {err}"} for it in items]


def rank(s, updated):
    fresh = bool(s["captured_at"] and updated and s["captured_at"] >= updated)
    return (2 if fresh else 0) + (1 if s["kind"] == "github-mirror" else 0)


def main(cand_path, out_path):
    papers = {}
    for r in json.load(open(cand_path))[0]["results"]:
        p = papers.setdefault(r["id"], {"id": r["id"], "updated": r["updated"], "pdf_key": r["pdf_key"], "sources": []})
        if r["kind"] in ("github-mirror", "wayback") and r["url"]:
            p["sources"].append({"kind": r["kind"], "url": r["url"], "captured_at": r["captured_at"]})
    done = set()
    if os.path.exists(out_path):
        done = {j["id"] for j in map(json.loads, open(out_path)) if j.get("ok")}
    todo = [p for p in papers.values() if not p["pdf_key"] and p["id"] not in done and p["sources"]]
    for p in todo:
        p["sources"].sort(key=lambda s: (rank(s, p["updated"]), s["captured_at"] or ""), reverse=True)
    print(f"to do {len(todo)} (done earlier {len(done)})", flush=True)

    qs = {"github-mirror": queue.Queue(), "wayback": queue.Queue()}
    for p in todo:
        qs[p["sources"][0]["kind"]].put((p, 0))
    lock = threading.Lock()
    out = open(out_path, "a")
    st = {"ok": 0, "fail": 0, "bytes": 0, "pending": len(todo), "t0": time.time()}

    def finish(p, idx, res):
        s = p["sources"][idx]
        if res.get("ok"):
            stale = 1 if (s["captured_at"] and p["updated"] and s["captured_at"] < p["updated"]) else 0
            rec = {"id": p["id"], "ok": True, "source": s["kind"], "url": s["url"], "captured_at": s["captured_at"],
                   "size": res["size"], "sha256": None, "stale": stale}
        elif idx + 1 < len(p["sources"]):
            qs[p["sources"][idx + 1]["kind"]].put((p, idx + 1))
            return
        else:
            rec = {"id": p["id"], "ok": False, "source": s["kind"], "url": s["url"], "error": str(res.get("error"))[:200]}
        with lock:
            out.write(json.dumps(rec) + "\n")
            out.flush()
            st["ok" if rec["ok"] else "fail"] += 1
            st["bytes"] += rec.get("size", 0)
            st["pending"] -= 1
            n = st["ok"] + st["fail"]
            if n % 500 == 0:
                print(f"{time.strftime('%H:%M:%S')} {n}/{len(todo)} ok={st['ok']} fail={st['fail']} "
                      f"{st['bytes'] / 1e9:.2f} GB, {n / (time.time() - st['t0']) * 60:.0f}/min", flush=True)

    def take(q, n):
        got = []
        while len(got) < n:
            try:
                got.append(q.get(timeout=2))
            except queue.Empty:
                break
        return got

    def gh_worker():
        while st["pending"] > 0:
            batch = take(qs["github-mirror"], GH_BATCH)
            if not batch:
                continue
            res = {r["id"]: r for r in call([{"id": p["id"], "url": p["sources"][i]["url"]} for p, i in batch])}
            for p, i in batch:
                finish(p, i, res.get(p["id"], {"ok": False, "error": "no result"}))

    def wb_worker():
        while st["pending"] > 0:
            batch = take(qs["wayback"], 1)
            if not batch:
                continue
            p, i = batch[0]
            r = call([{"id": p["id"], "url": p["sources"][i]["url"]}])[0]
            if not r.get("ok") and r.get("status") in (429, 503):
                time.sleep(120)  # Internet Archive is throttling: back off, then retry this paper
                qs["wayback"].put((p, i))
                continue
            finish(p, i, r)
            time.sleep(WB_GAP)

    threads = [threading.Thread(target=gh_worker) for _ in range(GH_THREADS)] + [threading.Thread(target=wb_worker)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    print(f"done: ok={st['ok']} fail={st['fail']} {st['bytes'] / 1e9:.2f} GB", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
