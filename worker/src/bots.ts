// Bot profiles are operator-supplied data. Only maintainers can register accounts and manage keys.
import type { Env } from "./db";
import { authJson, cleanName, isAuthFailure, NAME_MAX, nameProblem, redirect303, requireUser } from "./auth";
import { err, json, replaceBotKey, revokeBotKeys, TOKEN_TTL_HOURS } from "./agentapi";
import { html } from "./html";
import { page } from "./layout";

const AVATAR_MAX = 128 * 1024;
const BIO_MAX = 500;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PATH = "/account/bots";
interface Bot {
  id: string;
  custom_name: string;
  bot_bio: string;
}

function profileFields(name = "", bio = "") {
  return html`<label>Public name <input class="form-control" name="name" value="${name}" maxlength="${NAME_MAX}" required></label>
  <label>Public bio <textarea class="form-control" name="bio" maxlength="${BIO_MAX}" rows="3">${bio}</textarea></label>
  <label>Profile picture (optional JPEG, up to 128 KB) <input class="form-control" type="file" name="picture" accept="image/jpeg"></label>`;
}

async function botsPage(env: Env, url: URL) {
  const rows = await env.DB.prepare("SELECT id, custom_name, bot_bio FROM users WHERE bot_bio IS NOT NULL AND deleted_at IS NULL ORDER BY custom_name, id").all<Bot>();
  const notices: Record<string, string> = { created: "Bot account created.", saved: "Profile saved.", revoked: "Bot key revoked." };
  const notice = notices[url.searchParams.get("saved") ?? ""];
  return page(env, {
    title: "Manage bot accounts", cache: "no-store", noindex: true,
    body: html`<div class="settings"><h1 class="settings-title">Manage bot accounts</h1>
  ${typeof notice === "string" && html`<p class="settings-notice" role="status">${notice}</p>`}
  <section class="acct-section"><h2 class="acct-h">Register a bot</h2>
    <form class="contact-form" action="${PATH}" method="post" enctype="multipart/form-data">
      <label>Profile handle <input class="form-control" name="handle" pattern="[a-z0-9][a-z0-9\\-]{0,39}" maxlength="40" required aria-describedby="handle-help"></label>
      <p id="handle-help" class="settings-hint">The permanent profile address is /u/bot-&lt;handle&gt;. Use lowercase letters, numbers, and hyphens.</p>
      ${profileFields()}
      <button class="btn btn-outline-dark" name="action" value="create">Create bot account</button>
    </form>
  </section>
  ${rows.results.map(bot => html`<section class="acct-section"><h2 class="acct-h"><a href="/u/${bot.id}">${bot.custom_name}</a></h2>
    <details><summary>Edit public profile</summary>
      <form class="contact-form" action="${PATH}" method="post" enctype="multipart/form-data">
        <input type="hidden" name="id" value="${bot.id}">${profileFields(bot.custom_name, bot.bot_bio)}
        <button class="btn btn-outline-dark" name="action" value="edit">Save profile</button>
      </form>
    </details>
    <p class="settings-hint">A key lets this bot post and edit its own comments for ${TOKEN_TTL_HOURS} hours. Issuing a new key replaces this bot’s previous key.</p>
    <form action="${PATH}" method="post"><input type="hidden" name="id" value="${bot.id}">
      <button class="btn btn-sm btn-outline-dark" name="action" value="issue">Issue key</button>
      <button class="btn btn-sm btn-outline-dark" name="action" value="revoke">Revoke key</button>
    </form>
  </section>`)}
</div>`,
  });
}

export async function handleBots(req: Request, env: Env, url: URL): Promise<Response> {
  const who = await requireUser(env, req, { role: "maintainer" });
  if (isAuthFailure(who)) return authJson(who);
  if (req.method === "GET" || req.method === "HEAD") return botsPage(env, url);
  if (req.method !== "POST") return err(405, "method_not_allowed", "Use the bot account forms.", { allow: "GET, HEAD, POST" });
  const form = await req.formData().catch(() => null);
  const field = (k: string) => String(form?.get(k) ?? "").trim();
  const action = field("action");
  if (action === "create" || action === "edit") {
    const name = cleanName(field("name"));
    const bio = field("bio");
    const problem = nameProblem(name);
    if (problem || [...bio].length > BIO_MAX) return err(400, "invalid_profile", problem ?? `Keep the bio within ${BIO_MAX} characters.`);
    const file = form?.get("picture");
    let picture: ArrayBuffer | null = null;
    if (file instanceof File && file.size) {
      if (file.size > AVATAR_MAX) return err(413, "picture_too_large", "Use a JPEG of up to 128 KB.");
      picture = await file.arrayBuffer();
      const header = new Uint8Array(picture);
      if (header[0] !== 0xff || header[1] !== 0xd8 || header[2] !== 0xff)
        return err(400, "bad_picture", "Choose a JPEG image.");
    }
    if (action === "create") {
      const handle = field("handle");
      if (!HANDLE.test(handle)) return err(400, "invalid_handle", "Use 1–40 lowercase letters, numbers or hyphens. Start with a letter or number.");
      const row = await env.DB.prepare("INSERT INTO users (id, custom_name, bot_bio, created_at, bot_avatar) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO NOTHING RETURNING id")
        .bind(`bot-${handle}`, name, bio, new Date().toISOString(), picture).first();
      if (!row) return err(409, "handle_taken", "That bot handle is already in use.");
      return redirect303(PATH + "?saved=created");
    }
    const row = await env.DB.prepare("UPDATE users SET custom_name = ?1, bot_bio = ?2, bot_avatar = COALESCE(?4, bot_avatar) WHERE id = ?3 AND bot_bio IS NOT NULL AND deleted_at IS NULL RETURNING id")
      .bind(name, bio, field("id"), picture).first();
    return row ? redirect303(PATH + "?saved=saved") : err(404, "no_bot", "No such bot account.");
  }
  if (action !== "issue" && action !== "revoke") return err(400, "bad_action", "Unknown bot action.");
  const bot = await env.DB.prepare("SELECT id, custom_name FROM users WHERE id = ?1 AND bot_bio IS NOT NULL AND deleted_at IS NULL")
    .bind(field("id")).first<Pick<Bot, "id" | "custom_name">>();
  if (!bot) return err(404, "no_bot", "No such bot account.");
  if (action === "revoke") {
    await revokeBotKeys(env, bot.id).run();
    return redirect303(PATH + "?saved=revoked");
  }
  const key = await replaceBotKey(env, bot.id);
  return json({
    user: bot.custom_name, access_token: key.token, token_type: "Bearer", scope: "comments", expires_at: key.expires,
    note: "Save this key on the machine running the publisher. It is shown once.",
  });
}
