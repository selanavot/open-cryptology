import { type Env } from "./db";

// Belt-and-braces alarm for the metadata harvest. The harvest runs on GitHub Actions
// (.github/workflows/harvest.yml, pipeline/harvest_remote.py), which writes meta.harvest_last_ok
// after every successful run (every 8 h). If that is missing or older than STALE_AFTER, the
// Worker cron emails the maintainer, at most once per RESEND_EVERY.

const STALE_AFTER = 26 * 3600_000;
const RESEND_EVERY = 24 * 3600_000;
const LAST_ALERT_KEY = "harvest_stale_alert_at";

export async function checkHarvestStaleness(env: Env): Promise<Record<string, unknown>> {
  const rows = await env.DB.prepare("SELECT key, value FROM meta WHERE key IN (?1, ?2, ?3)")
    .bind("harvest_last_ok", "harvest_last_run", LAST_ALERT_KEY)
    .all<{ key: string; value: string }>();
  const meta = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  const now = Date.now();
  const lastOk = meta.harvest_last_ok ? Date.parse(meta.harvest_last_ok) : NaN;
  if (Number.isFinite(lastOk) && now - lastOk <= STALE_AFTER) return { stale: false, lastOk: meta.harvest_last_ok };

  const lastAlert = meta[LAST_ALERT_KEY] ?? null;
  if (lastAlert && now - Date.parse(lastAlert) < RESEND_EVERY) return { stale: true, alerted: false, lastAlert };
  if (!env.MAILER || !env.CONTACT_TO || !env.CONTACT_FROM) {
    console.error("metadata harvest is stale but MAILER/CONTACT_TO/CONTACT_FROM are not configured");
    return { stale: true, alerted: false, reason: "mail not configured" };
  }
  // Claim the slot atomically, so overlapping cron runs send one email between them.
  const claim = await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value IS ?3`,
  )
    .bind(LAST_ALERT_KEY, new Date(now).toISOString(), lastAlert)
    .run();
  if (!claim.meta.changes) return { stale: true, alerted: false };

  const age = Number.isFinite(lastOk) ? `${Math.round((now - lastOk) / 3600_000)} hours ago` : "never recorded";
  const repo = env.REPO_URL.replace(/\/$/, "");
  try {
    await env.MAILER.send({
      from: { name: `${env.SITE_NAME} monitor`, email: env.CONTACT_FROM },
      to: env.CONTACT_TO,
      subject: `[${env.SITE_NAME}] Metadata harvest is stale`,
      text: [
        `The last successful ePrint metadata harvest was ${age}` +
          (meta.harvest_last_ok ? ` (${meta.harvest_last_ok}).` : "."),
        "New and updated ePrint papers are not reaching the site.",
        "",
        `Last run: ${meta.harvest_last_run ?? "(none recorded)"}`,
        "",
        `Check the "Metadata harvest" workflow: ${repo}/actions/workflows/harvest.yml`,
        "Common causes: the CLOUDFLARE_API_TOKEN repository secret is missing or expired, ePrint is",
        "blocking the GitHub runners, or scheduled workflows were disabled (GitHub turns them off",
        "after 60 days without repository activity).",
        "",
        `You'll get at most one of these emails every ${RESEND_EVERY / 3600_000} hours.`,
      ].join("\n"),
    });
  } catch (e) {
    // Give the slot back so the next cron run tries again.
    await env.DB.prepare("UPDATE meta SET value = ?2 WHERE key = ?1").bind(LAST_ALERT_KEY, lastAlert ?? "").run();
    throw e;
  }
  return { stale: true, alerted: true };
}
