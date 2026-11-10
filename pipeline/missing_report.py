"""Spreadsheet (CSV) of live papers that still have no mirrored PDF after a prefill run.

  python3 -I pipeline/missing_report.py data/prefill/candidates.json data/prefill/results.jsonl OUT.csv
"""

import csv
import json
import sys


def main(cand_path, results_path, out_path):
    rows = json.load(open(cand_path))[0]["results"]
    papers = {}
    for r in rows:
        p = papers.setdefault(r["id"], {**{k: r[k] for k in ("id", "year", "num", "title", "updated", "license_code", "pdf_key")},
                                        "sources": set()})
        if r["kind"]:
            p["sources"].add(r["kind"])
    ok, last_err = set(), {}
    for line in open(results_path):
        j = json.loads(line)
        if j.get("ok"):
            ok.add(j["id"])
        else:
            last_err[j["id"]] = f"{j['source']}: {j.get('error', '')}"
    missing = [p for p in papers.values() if not p["pdf_key"] and p["id"] not in ok]
    missing.sort(key=lambda p: (-p["year"], -p["num"]))
    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["paper", "year", "title", "license", "last updated on ePrint", "why missing",
                    "ePrint page", "upload here (private preview)"])
        for p in missing:
            why = last_err.get(p["id"]) or ("no known public copy" if not p["sources"] else "not attempted yet")
            w.writerow([p["id"], p["year"], p["title"], p["license_code"] or "", (p["updated"] or "")[:10], why,
                        f"https://eprint.iacr.org/{p['id']}",
                        f"https://open-cryptology.opencryptology.workers.dev/{p['id']}"])
    by_year = {}
    for p in missing:
        by_year[p["year"]] = by_year.get(p["year"], 0) + 1
    print(f"{len(missing)} missing of {len(papers)} live papers; by year: "
          + ", ".join(f"{y}:{n}" for y, n in sorted(by_year.items())))


if __name__ == "__main__":
    main(*sys.argv[1:4])
