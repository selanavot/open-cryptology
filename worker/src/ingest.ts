import { type Env } from "./db";

// Cloud PDF ingestion, designed for the Workers Free plan: a once-a-minute Cron Trigger that
// streams a few PDFs per run from known public copies (community GitHub mirror, Wayback Machine)
// into R2. Never fetches PDFs from eprint.iacr.org. Free-plan limits that shape it: 10 ms CPU per
// invocation (I/O waits don't count, so no SHA-256 here; R2 keeps its own MD5), 50 subrequests,
// 50 D1 queries. Kill switch: set INGEST_ENABLED to anything but "1".

const UA =
  "open-cryptology-ingest/0.1 (unofficial non-commercial ePrint mirror; fetches public copies only)";
const MAX_BYTES = 25 * 1024 * 1024;
const PER_RUN = { "github-mirror": 8, wayback: 1 } as const;
type Kind = keyof typeof PER_RUN;
const HOST_PAUSE_MIN = 30; // pause a source host after a 403/429
const LOCK_SECONDS = 110; // a run never overlaps the next one

interface Candidate {
  id: string;
  updated: string | null;
  kind: string;
  url: string;
  captured_at: string | null;
}

const nowIso = () => new Date().toISOString();
const plusMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

async function getMeta(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
async function setMeta(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

/** Pick the best source per paper: a capture at/after the paper's last update wins (GitHub first),
 *  otherwise the newest capture. Returns at most PER_RUN[kind] papers per source kind. */
export function plan(rows: Candidate[], paused: Set<string>): Candidate[] {
  const byPaper = new Map<string, Candidate[]>();
  for (const r of rows) {
    if (!(r.kind in PER_RUN)) continue;
    const list = byPaper.get(r.id) ?? [];
    list.push(r);
    byPaper.set(r.id, list);
  }
  const quota: Record<string, number> = { ...PER_RUN };
  const picked: Candidate[] = [];
  for (const [, cands] of byPaper) {
    const fresh = (c: Candidate) => !!c.captured_at && !!c.updated && c.captured_at >= c.updated;
    const rank = (c: Candidate) => (fresh(c) ? 2 : 0) + (c.kind === "github-mirror" ? 1 : 0);
    cands.sort((a, b) => rank(b) - rank(a) || (b.captured_at ?? "").localeCompare(a.captured_at ?? ""));
    const best = cands.find((c) => !paused.has(c.kind));
    if (!best || quota[best.kind] <= 0) continue;
    quota[best.kind]--;
    picked.push(best);
    if (Object.values(quota).every((q) => q <= 0)) break;
  }
  return picked;
}

type Outcome = { ok: true; size: number } | { ok: false; error: string; hostBlocked?: boolean; permanent?: boolean };

async function ingestOne(env: Env, c: Candidate): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetch(c.url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(45_000) });
  } catch (e) {
    return { ok: false, error: `fetch: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (res.status === 403 || res.status === 429) return { ok: false, error: `HTTP ${res.status}`, hostBlocked: true };
  if (res.status === 404 || res.status === 410) return { ok: false, error: `HTTP ${res.status}`, permanent: true };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) return { ok: false, error: `too large (${len} B)`, permanent: true };

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) return { ok: false, error: `too large (${buf.byteLength} B)`, permanent: true };
  const magic = new Uint8Array(buf, 0, Math.min(5, buf.byteLength));
  if (String.fromCharCode(...magic) !== "%PDF-") return { ok: false, error: "not a PDF (bad magic)" };

  const key = `pdf/${c.id}.pdf`;
  await env.PDFS.put(key, buf, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { source: c.kind, source_url: c.url, source_date: c.captured_at ?? "" },
  });
  const stale = c.captured_at && c.updated && c.captured_at < c.updated ? 1 : 0;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE papers SET pdf_key = ?, pdf_sha256 = NULL, pdf_size = ?, pdf_source = ?, pdf_source_date = ?,
       pdf_maybe_stale = ? WHERE id = ?`,
    ).bind(key, buf.byteLength, c.kind, c.captured_at, stale, c.id),
    env.DB.prepare("DELETE FROM ingest_state WHERE paper_id = ?").bind(c.id),
  ]);
  return { ok: true, size: buf.byteLength };
}

async function recordFailure(env: Env, c: Candidate, o: Extract<Outcome, { ok: false }>): Promise<void> {
  const prev = await env.DB.prepare("SELECT attempts FROM ingest_state WHERE paper_id = ?")
    .bind(c.id)
    .first<{ attempts: number }>();
  const attempts = (prev?.attempts ?? 0) + 1;
  // 1 h, 2 h, 4 h ... capped at 7 days; permanent errors wait 30 days (sources get re-discovered).
  const waitMin = o.permanent ? 30 * 24 * 60 : Math.min(60 * 2 ** (attempts - 1), 7 * 24 * 60);
  await env.DB.prepare(
    `INSERT INTO ingest_state(paper_id, attempts, last_error, last_source, next_try_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(paper_id) DO UPDATE SET attempts = excluded.attempts, last_error = excluded.last_error,
       last_source = excluded.last_source, next_try_at = excluded.next_try_at`,
  )
    .bind(c.id, attempts, o.error.slice(0, 300), c.kind, plusMinutes(waitMin))
    .run();
}

export async function runIngest(env: Env): Promise<Record<string, unknown>> {
  if (env.INGEST_ENABLED !== "1") return { skipped: "disabled" };
  const lock = await getMeta(env, "ingest_lock");
  if (lock && Date.now() - Date.parse(lock) < LOCK_SECONDS * 1000) return { skipped: "locked" };
  await setMeta(env, "ingest_lock", nowIso());

  const paused = new Set<string>();
  for (const k of Object.keys(PER_RUN)) {
    const until = await getMeta(env, `ingest_pause_${k}`);
    if (until && until > nowIso()) paused.add(k);
  }

  // Candidate papers per source kind (newest first), then all their sources so plan() can prefer
  // a fresh capture. Wayback candidates are papers the GitHub mirror doesn't have.
  const eligible = `p.pdf_key IS NULL AND p.withdrawn = 0
        AND NOT EXISTS (SELECT 1 FROM ingest_state i WHERE i.paper_id = p.id AND i.next_try_at > ?1)`;
  const { results } = await env.DB.prepare(
    `WITH cand AS (
       SELECT id FROM (SELECT p.id FROM papers p WHERE ${eligible}
           AND EXISTS (SELECT 1 FROM sources s WHERE s.paper_id = p.id AND s.kind = 'github-mirror')
           ORDER BY p.year DESC, p.num DESC LIMIT 20)
       UNION
       SELECT id FROM (SELECT p.id FROM papers p WHERE ${eligible}
           AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.paper_id = p.id AND s.kind = 'github-mirror')
           AND EXISTS (SELECT 1 FROM sources s WHERE s.paper_id = p.id AND s.kind = 'wayback')
           ORDER BY p.year DESC, p.num DESC LIMIT 5))
     SELECT p.id, p.updated, s.kind, s.url, s.captured_at
       FROM cand JOIN papers p ON p.id = cand.id JOIN sources s ON s.paper_id = p.id
      ORDER BY p.year DESC, p.num DESC`,
  )
    .bind(nowIso())
    .all<Candidate>();

  const batch = plan(results ?? [], paused);
  const summary = { tried: batch.length, ok: 0, failed: 0, bytes: 0, paused: [...paused], errors: [] as string[] };
  for (const c of batch) {
    if (paused.has(c.kind)) continue;
    const o = await ingestOne(env, c);
    if (o.ok) {
      summary.ok++;
      summary.bytes += o.size;
    } else {
      summary.failed++;
      summary.errors.push(`${c.id} ${c.kind}: ${o.error}`);
      await recordFailure(env, c, o);
      if (o.hostBlocked) {
        paused.add(c.kind);
        await setMeta(env, `ingest_pause_${c.kind}`, plusMinutes(HOST_PAUSE_MIN));
      }
    }
  }
  await setMeta(env, "ingest_last_run", JSON.stringify({ at: nowIso(), ...summary }));
  await env.DB.prepare("DELETE FROM meta WHERE key = 'ingest_lock'").run();
  return summary;
}
