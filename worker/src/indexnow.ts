import type { Env } from "./db";

// IndexNow (https://www.indexnow.org): tell Bing (which also feeds ChatGPT search, Copilot and
// DuckDuckGo), Yandex, Naver, Seznam and others which pages changed, instead of waiting for them
// to recrawl the sitemap. Runs from the Worker cron (every 4 h, after the GitHub Actions harvest
// has written new metadata). Off unless the INDEXNOW_KEY secret is set; the key is also served at
// /<key>.txt, which is how IndexNow checks that we own the host.
//
// What counts as changed since the last run, tracked in `meta`:
//   - new papers: rowid above indexnow_rowid (late-approved papers arrive with an old `updated`,
//     so `updated` alone would miss them; a harvest upsert keeps an existing row's rowid);
//   - metadata edits on ePrint: `updated` above indexnow_updated;
//   - new PDFs: versions.added_at above indexnow_at.
// The first run only records the watermarks: the sitemap covers everything older.

const ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_URLS = 10_000; // IndexNow's limit per request
const KEY_RE = /^[A-Za-z0-9-]{8,128}$/;

export const indexNowKey = (env: Env): string | null =>
  env.INDEXNOW_KEY && KEY_RE.test(env.INDEXNOW_KEY) ? env.INDEXNOW_KEY : null;

/** GET /<key>.txt: the key file IndexNow fetches to verify the host. */
export function indexNowKeyFile(env: Env, path: string): Response | null {
  const key = indexNowKey(env);
  if (!key || path !== `/${key}.txt`) return null;
  return new Response(key, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" } });
}

const KEYS = ["indexnow_rowid", "indexnow_updated", "indexnow_at"] as const;

export async function pingIndexNow(env: Env): Promise<Record<string, unknown>> {
  const key = indexNowKey(env);
  if (!key || !env.SITE_URL) return { skipped: "INDEXNOW_KEY or SITE_URL not set" };
  const origin = env.SITE_URL.replace(/\/$/, "");
  const host = new URL(origin).host;

  const rows = await env.DB.prepare("SELECT key, value FROM meta WHERE key IN (?1, ?2, ?3)")
    .bind(...KEYS)
    .all<{ key: string; value: string }>();
  const meta = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  const startedAt = new Date().toISOString();
  const [maxRow, maxUpd] = await env.DB.batch([
    env.DB.prepare("SELECT max(rowid) AS v FROM papers"),
    env.DB.prepare("SELECT max(updated) AS v FROM papers"),
  ]);
  const now = {
    indexnow_rowid: String((maxRow.results?.[0] as { v?: number } | undefined)?.v ?? 0),
    indexnow_updated: String((maxUpd.results?.[0] as { v?: string } | undefined)?.v ?? ""),
    indexnow_at: startedAt,
  };
  const save = () =>
    env.DB.batch(
      KEYS.map((k) =>
        env.DB.prepare("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, now[k]),
      ),
    );
  if (!KEYS.every((k) => meta[k] !== undefined)) {
    await save();
    return { initialized: now };
  }

  const changed = await env.DB.prepare(
    `SELECT id FROM papers WHERE (withdrawn = 0 OR title <> '') AND (rowid > ?1 OR updated > ?2)
     UNION
     SELECT paper_id AS id FROM versions WHERE added_at > ?3
     LIMIT ?4`,
  )
    .bind(Number(meta.indexnow_rowid), meta.indexnow_updated, meta.indexnow_at, MAX_URLS)
    .all<{ id: string }>();
  const ids = (changed.results ?? []).map((r) => r.id);
  if (!ids.length) {
    await save();
    return { sent: 0 };
  }
  const urlList = ids.map((id) => `${origin}/${id}`);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host, key, keyLocation: `${origin}/${key}.txt`, urlList }),
  });
  // 200 OK / 202 Accepted (key check pending). Anything else: keep the watermarks so the next run retries.
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(`IndexNow answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  await save();
  return { sent: urlList.length, status: res.status };
}
