// A test Worker: the real fetch handler over an in-memory D1 (node:sqlite, loaded from
// db/schema.sql), with helpers to sign people and bots in. Use from *.test.ts:
//   const t = await testWorker();  const me = await t.person({ orcid: "0000-0002-7804-6696" });
//   const res = await t.get("/2025/542", me);
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index";
import type { Env } from "../src/db";
import { randomId, sha256hex } from "../src/auth";

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "schema.sql");

type Val = SQLInputValue;
const toVal = (v: unknown): Val => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as Val));

/** Enough of D1's API for the Worker: prepare/bind/first/all/run/raw and batch. */
class Stmt {
  constructor(
    private db: DatabaseSync,
    readonly sql: string,
    private args: Val[] = [],
  ) {}
  bind(...a: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, a.map(toVal));
  }
  private reader() {
    const s = this.db.prepare(this.sql);
    s.setReadBigInts(false);
    return s;
  }
  async first<T>(col?: string): Promise<T | null> {
    const r = this.reader().get(...this.args) as Record<string, unknown> | undefined;
    if (!r) return null;
    return (col ? r[col] : { ...r }) as T;
  }
  async all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const s = this.reader();
    const rows = s.columns().length ? (s.all(...this.args) as T[]) : (s.run(...this.args), []);
    return { results: rows.map((r) => ({ ...r })) as T[], success: true, meta: { changes: 0 } };
  }
  async run(): Promise<{ success: true; results: unknown[]; meta: { changes: number; last_row_id: number } }> {
    const s = this.reader();
    if (s.columns().length) {
      const rows = s.all(...this.args);
      return { success: true, results: rows, meta: { changes: rows.length, last_row_id: 0 } };
    }
    const r = s.run(...this.args);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw<T>(): Promise<T[]> {
    const s = this.reader();
    s.setReturnArrays(true);
    return s.all(...this.args) as T[];
  }
}

export class FakeD1 {
  readonly db = new DatabaseSync(":memory:");
  constructor() {
    this.db.exec(readFileSync(SCHEMA, "utf8"));
  }
  prepare(sql: string): Stmt {
    return new Stmt(this.db, sql);
  }
  async batch(stmts: Stmt[]) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run()); // run(): D1's batch reports meta.changes
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string) {
    this.db.exec(sql);
  }
  /** Synchronous helpers for test setup. */
  run(sql: string, ...a: unknown[]) {
    return this.db.prepare(sql).run(...a.map(toVal));
  }
  rows<T>(sql: string, ...a: unknown[]): T[] {
    return this.db.prepare(sql).all(...a.map(toVal)).map((r) => ({ ...r })) as T[];
  }
}

/** Enough of R2 for uploads and downloads: put/get/head/delete over a Map. */
export class FakeR2 {
  readonly objects = new Map<string, { body: Uint8Array; httpMetadata?: unknown; customMetadata?: Record<string, string> }>();
  async put(key: string, body: ArrayBuffer | Uint8Array | string, o: { httpMetadata?: unknown; customMetadata?: Record<string, string> } = {}) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body instanceof Uint8Array ? body : new Uint8Array(body));
    this.objects.set(key, { body: bytes, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
    return this.meta(key);
  }
  private meta(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      key,
      size: o.body.byteLength,
      etag: "e",
      httpEtag: '"e"',
      uploaded: new Date(),
      httpMetadata: o.httpMetadata ?? {},
      customMetadata: o.customMetadata ?? {},
      writeHttpMetadata(h: Headers) {
        const ct = (o.httpMetadata as { contentType?: string } | undefined)?.contentType;
        if (ct) h.set("content-type", ct);
      },
    };
  }
  async head(key: string) {
    return this.meta(key);
  }
  async get(key: string) {
    const m = this.meta(key);
    if (!m) return null;
    const body = this.objects.get(key)!.body;
    return { ...m, body: new Response(body).body, arrayBuffer: async () => body.slice().buffer, text: async () => new TextDecoder().decode(body) };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
}

export const ORIGIN = "https://opencryptology.test";
export const MAINTAINER_GITHUB_ID = "4242";

export interface Who {
  id: string;
  cookie?: string;
  token?: string;
}

const nextId = (p: string) => (p === "b" ? `bot-${randomId(8)}` : randomId());

export async function testWorker(over: Partial<Env> = {}) {
  const d1 = new FakeD1();
  const r2 = new FakeR2();
  const mail: { to: string; subject: string; text: string }[] = [];
  const env = {
    DB: d1 as unknown as D1Database,
    PDFS: r2 as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response("asset", { status: 404 }) } as unknown as Fetcher,
    SITE_NAME: "Open Cryptology",
    SITE_URL: ORIGIN,
    REPO_URL: "https://github.com/example/open-cryptology",
    SPONSOR_URL: "https://github.com/sponsors/example",
    ISSUES_URL: "https://github.com/example/open-cryptology/issues",
    ORIGIN_BASE: "https://eprint.iacr.org",
    MAINTAINER_GITHUB_IDS: MAINTAINER_GITHUB_ID,
    REQUIRE_ACCESS: "0",
    CONTACT_TO: "maintainer@example.test",
    CONTACT_FROM: "contact@example.test",
    MAILER: {
      send: async (m: { to: string; subject?: string; text?: string; raw?: unknown }) => {
        mail.push({ to: String(m.to), subject: String(m.subject ?? ""), text: String(m.text ?? "") });
      },
    } as unknown as SendEmail,
    ...over,
  } as Env;
  const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const now = () => new Date().toISOString();

  /** An ePrint paper. */
  function paper(id: string, authors: string[]) {
    const [y, n] = id.split("/").map(Number);
    d1.run(
      "INSERT INTO papers (id, year, num, title, authors, abstract, license_url, license_code, submitted, updated) VALUES (?1, ?2, ?3, ?4, ?5, 'An abstract.', 'https://creativecommons.org/licenses/by/4.0/', 'CC BY', ?6, ?6)",
      id, y, n, `Paper ${id}`, JSON.stringify(authors), now(),
    );
  }

  async function session(userId: string): Promise<string> {
    const tok = `tok-${nextId("s")}`;
    const t = now();
    d1.run(
      "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?3)",
      await sha256hex(tok), userId, t, new Date(Date.now() + 86400_000).toISOString(),
    );
    return `__Host-oc_session=${tok}`;
  }

  /** A signed-in person; `orcid` adds an ORCID sign-in, `maintainer` a maintainer GitHub sign-in. */
  async function person(o: { name?: string; orcid?: string; maintainer?: boolean } = {}): Promise<Who> {
    const id = nextId("u");
    d1.run("INSERT INTO users (id, created_at) VALUES (?1, ?2)", id, now());
    const ident = (provider: string, pid: string, url: string) =>
      d1.run(
        "INSERT INTO identities (provider, provider_user_id, user_id, handle, url, name, avatar, created_at) VALUES (?1, ?2, ?3, ?2, ?4, ?5, '', ?6)",
        provider, pid, id, url, o.name ?? `Person ${id}`, now(),
      );
    if (o.orcid) ident("orcid", o.orcid, `https://orcid.org/${o.orcid}`);
    if (o.maintainer) ident("github", MAINTAINER_GITHUB_ID, "https://github.com/maint");
    if (!o.orcid && !o.maintainer) ident("google", `g-${id}`, "");
    return { id, cookie: await session(id) };
  }

  /** A bot account with a live API key (Bearer token). */
  async function bot(name = "Bot"): Promise<Who> {
    const id = nextId("b");
    d1.run("INSERT INTO users (id, custom_name, bot_bio, created_at) VALUES (?1, ?2, '', ?3)", id, `${name} ${id}`, now());
    const token = `oct_${nextId("k")}${"x".repeat(30)}`;
    d1.run(
      "INSERT INTO api_tokens (id, hash, user_id, scopes, created_at, expires_at) VALUES (?1, ?2, ?3, 'comments', ?4, ?5)",
      nextId("t"), await sha256hex(token), id, now(), new Date(Date.now() + 86400_000).toISOString(),
    );
    return { id, token };
  }

  /** An API token (comments scope) for a person, as their agent would hold. */
  async function token(who: Who): Promise<Who> {
    const tok = `oct_${randomId(24)}`;
    d1.run(
      "INSERT INTO api_tokens (id, hash, user_id, scopes, created_at, expires_at) VALUES (?1, ?2, ?3, 'manuscripts comments', ?4, ?5)",
      randomId(), await sha256hex(tok), who.id, now(), new Date(Date.now() + 86400_000).toISOString(),
    );
    return { id: who.id, token: tok };
  }

  function headers(who?: Who, extra: Record<string, string> = {}): Headers {
    const h = new Headers(extra);
    if (who?.cookie) h.set("cookie", who.cookie);
    if (who?.token) h.set("authorization", `Bearer ${who.token}`);
    return h;
  }

  async function fetch(path: string, init: RequestInit & { who?: Who } = {}): Promise<Response> {
    const { who, ...rest } = init;
    const h = headers(who, Object.fromEntries(new Headers(rest.headers ?? {}).entries()));
    if (rest.method && rest.method !== "GET" && rest.method !== "HEAD" && !h.has("origin")) h.set("origin", ORIGIN);
    return worker.fetch(new Request(ORIGIN + path, { ...rest, headers: h, redirect: "manual" }), env, ctx);
  }

  const get = (path: string, who?: Who, h: Record<string, string> = {}) => fetch(path, { who, headers: h });
  const text = async (path: string, who?: Who, h: Record<string, string> = {}) => (await get(path, who, h)).text();
  const form = (path: string, fields: Record<string, string>, who?: Who) =>
    fetch(path, { method: "POST", who, body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const postJson = (path: string, body: unknown, who?: Who, method = "POST") =>
    fetch(path, { method, who, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  /** multipart/form-data POST (e.g. a PDF with its metadata). */
  const multipart = (path: string, fd: FormData, who?: Who) => fetch(path, { method: "POST", who, body: fd });

  return { env, d1, r2, mail, paper, person, bot, token, fetch, get, text, form, postJson, multipart };
}

export type TestWorker = Awaited<ReturnType<typeof testWorker>>;
