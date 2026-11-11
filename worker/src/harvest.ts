import { type Env } from "./db";
import { parseGetRecord, upsert } from "./oai";

// Scheduled metadata harvest: incremental OAI-PMH ListRecords from ePrint (metadata is CC0),
// starting at meta.last_harvest. Metadata only — this never fetches PDFs. Polite: one client,
// a few pages per run, >= 3 s between pages, stops at the first 403/429 and tries again next run.
// Kill switch: HARVEST_ENABLED != "1". OFF in production: ePrint's Cloudflare challenges requests
// from Workers, so the harvest runs on GitHub Actions instead (pipeline/harvest_remote.py). Kept
// for the day that changes.

const USER_AGENT =
  "open-cryptology-worker/0.1 (unofficial non-commercial ePrint mirror; incremental OAI-PMH metadata harvest)";
const MAX_PAGES_PER_RUN = 3;
const PAGE_GAP_MS = 3000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getMeta(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
async function setMeta(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

/** Split a ListRecords response into per-record XML chunks. */
export function records(xml: string): string[] {
  return xml.match(/<record\b[\s\S]*?<\/record>/g) ?? [];
}

export function resumptionToken(xml: string): string | null {
  const m = /<resumptionToken\b[^>]*>([^<]+)<\/resumptionToken>/.exec(xml);
  return m ? m[1].trim() : null;
}

export async function runHarvest(env: Env): Promise<Record<string, unknown>> {
  if (env.HARVEST_ENABLED !== "1") return { skipped: "disabled" };
  const from = await getMeta(env, "last_harvest");
  if (!from) return { skipped: "no meta.last_harvest (load the initial dump first)" };

  const base = `${env.ORIGIN_BASE.replace(/\/$/, "")}/oai`;
  let url = `${base}?verb=ListRecords&metadataPrefix=oai_dc&from=${encodeURIComponent(from)}`;
  const summary = { at: new Date().toISOString(), from, pages: 0, records: 0, upserted: 0, newest: from, status: "ok" as string };

  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    if (page > 0) await sleep(PAGE_GAP_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/xml, text/xml" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      summary.status = `fetch error: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
    if (!res.ok) {
      summary.status = `HTTP ${res.status}${res.status === 403 || res.status === 429 ? " (blocked or rate-limited; not retrying this run)" : ""}`;
      break;
    }
    const xml = await res.text();
    summary.pages++;
    // ePrint's Cloudflare answers Workers with a 200 challenge page; never count that as "0 records".
    if (!xml.includes("<OAI-PMH")) {
      summary.status = "blocked or unexpected response (not OAI-PMH XML)";
      break;
    }
    if (/<error\b[^>]*code="noRecordsMatch"/.test(xml)) break;
    const err = /<error\b[^>]*code="([^"]*)"/.exec(xml);
    if (err) {
      summary.status = `OAI error ${err[1]}`;
      break;
    }
    for (const chunk of records(xml)) {
      summary.records++;
      const parsed = parseGetRecord(chunk);
      if ("error" in parsed) continue;
      await upsert(env, parsed.record);
      summary.upserted++;
      const d = parsed.record.updated;
      if (d && d > summary.newest) summary.newest = d;
    }
    // Advance the watermark after every page, so a later failure doesn't redo finished work.
    if (summary.newest > from) await setMeta(env, "last_harvest", summary.newest);
    const token = resumptionToken(xml);
    if (!token) break;
    url = `${base}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`;
  }
  await setMeta(env, "harvest_last_run", JSON.stringify(summary));
  return summary;
}
