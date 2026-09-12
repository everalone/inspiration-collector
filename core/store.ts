import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import { DB_PATH, DATA_DIR } from "./config.js";
import type { ExtractedItem } from "./extract.js";

export interface ArticleRow {
  id: string;
  url: string;
  title: string;
  account: string;
  publish_date: string;
  description: string;
  summary: string;
  article_type: string;
  tags: string;
  images_dir: string;
  status: string; // ok | error
  error: string;
  fetched_at: string;
  processed_at: string | null;
}

export interface ItemRow {
  id: string;
  article_id: string;
  type: ExtractedItem["type"];
  title: string;
  payload: string;
  tags: string;
  verify_status: string; // ok | unsure | dead
  verify_detail: string; // JSON: palette→ColorCheck[]，website→UrlCheck
  source_image_index: number;
  bbox: string; // JSON [x1,y1,x2,y2] 0~1000 或 ''
  created_at: string;
  edited: number;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT DEFAULT '',
      account TEXT DEFAULT '',
      publish_date TEXT DEFAULT '',
      description TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      article_type TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      images_dir TEXT DEFAULT '',
      status TEXT DEFAULT 'ok',
      error TEXT DEFAULT '',
      fetched_at TEXT DEFAULT '',
      processed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      tags TEXT DEFAULT '[]',
      verify_status TEXT DEFAULT 'ok',
      verify_detail TEXT DEFAULT '{}',
      source_image_index INTEGER DEFAULT 0,
      bbox TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      edited INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
    CREATE INDEX IF NOT EXISTS idx_items_article ON items(article_id);
  `);
  try {
    // 旧库迁移：补 bbox 列
    db.exec("ALTER TABLE items ADD COLUMN bbox TEXT DEFAULT ''");
  } catch {
    /* 列已存在 */
  }
  return db;
}

export function upsertArticle(a: {
  id: string; url: string; title: string; account: string; publishDate: string;
  description: string; summary?: string; articleType?: string; tags?: string[];
  imagesDir?: string; status?: string; error?: string; processed?: boolean;
}): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO articles (id, url, title, account, publish_date, description, summary, article_type, tags, images_dir, status, error, fetched_at, processed_at)
    VALUES (@id, @url, @title, @account, @publish_date, @description, @summary, @article_type, @tags, @images_dir, @status, @error, @fetched_at, @processed_at)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, account=excluded.account, publish_date=excluded.publish_date,
      description=excluded.description, summary=excluded.summary, article_type=excluded.article_type,
      tags=excluded.tags, images_dir=excluded.images_dir, status=excluded.status, error=excluded.error,
      processed_at=COALESCE(excluded.processed_at, articles.processed_at)
  `).run({
    id: a.id, url: a.url, title: a.title, account: a.account,
    publish_date: a.publishDate, description: a.description,
    summary: a.summary ?? "", article_type: a.articleType ?? "",
    tags: JSON.stringify(a.tags ?? []), images_dir: a.imagesDir ?? "",
    status: a.status ?? "ok", error: a.error ?? "",
    fetched_at: new Date().toISOString(),
    processed_at: a.processed ? new Date().toISOString() : null,
  });
}

export function replaceItems(articleId: string, items: ExtractedItem[], verifyResults: Map<string, { status: string; detail: unknown }>, articleTags: string[] = []): number {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM items WHERE article_id = ?").run(articleId);
    const ins = d.prepare(`
      INSERT INTO items (id, article_id, type, title, payload, tags, verify_status, verify_detail, source_image_index, bbox, created_at, edited)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    const now = new Date().toISOString();
    for (const it of items) {
      const key = itemKey(it);
      const v = verifyResults.get(key) ?? { status: "ok", detail: {} };
      ins.run(
        crypto.randomUUID(), articleId, it.type, it.title,
        JSON.stringify(it.payload ?? {}), JSON.stringify(articleTags),
        v.status, JSON.stringify(v.detail ?? {}), it.source_image_index ?? 0,
        it.bbox?.length === 4 ? JSON.stringify(it.bbox) : "", now
      );
    }
  });
  tx();
  return items.length;
}

function itemKey(it: ExtractedItem): string {
  return JSON.stringify([it.type, it.title, it.payload]);
}

export function updateItem(id: string, patch: { title?: string; payload?: unknown; tags?: string[]; verifyStatus?: string; verifyDetail?: unknown }): void {
  const d = getDb();
  const sets: string[] = ["edited = 1"];
  const vals: Record<string, unknown> = { id };
  if (patch.title !== undefined) { sets.push("title = @title"); vals.title = patch.title; }
  if (patch.payload !== undefined) { sets.push("payload = @payload"); vals.payload = JSON.stringify(patch.payload); }
  if (patch.tags !== undefined) { sets.push("tags = @tags"); vals.tags = JSON.stringify(patch.tags); }
  if (patch.verifyStatus !== undefined) { sets.push("verify_status = @vs"); vals.vs = patch.verifyStatus; }
  if (patch.verifyDetail !== undefined) { sets.push("verify_detail = @vd"); vals.vd = JSON.stringify(patch.verifyDetail); }
  d.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = @id`).run(vals);
}

export function deleteItem(id: string): void {
  getDb().prepare("DELETE FROM items WHERE id = ?").run(id);
}

export interface ItemFilter {
  type?: string;
  tag?: string;
  q?: string;
  verify?: string;
  limit?: number;
  offset?: number;
}

export function listItems(f: ItemFilter = {}): ItemRow[] {
  const d = getDb();
  const where: string[] = [];
  const vals: Record<string, unknown> = {};
  if (f.type && f.type !== "all") { where.push("type = @type"); vals.type = f.type; }
  if (f.verify) { where.push("verify_status = @verify"); vals.verify = f.verify; }
  if (f.tag) { where.push("tags LIKE @tag"); vals.tag = `%"${f.tag}"%`; }
  if (f.q) {
    where.push("(title LIKE @q OR payload LIKE @q OR tags LIKE @q OR article_id IN (SELECT id FROM articles WHERE title LIKE @q OR account LIKE @q))");
    vals.q = `%${f.q}%`;
  }
  const sql = `SELECT * FROM items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, article_id DESC LIMIT @limit OFFSET @offset`;
  return d.prepare(sql).all({ limit: f.limit ?? 500, offset: f.offset ?? 0, ...vals }) as ItemRow[];
}

export function countItems(f: ItemFilter = {}): number {
  const d = getDb();
  const where: string[] = [];
  const vals: Record<string, unknown> = {};
  if (f.type && f.type !== "all") { where.push("type = @type"); vals.type = f.type; }
  if (f.verify) { where.push("verify_status = @verify"); vals.verify = f.verify; }
  if (f.tag) { where.push("tags LIKE @tag"); vals.tag = `%"${f.tag}"%`; }
  if (f.q) {
    where.push("(title LIKE @q OR payload LIKE @q OR tags LIKE @q OR article_id IN (SELECT id FROM articles WHERE title LIKE @q OR account LIKE @q))");
    vals.q = `%${f.q}%`;
  }
  return (d.prepare(`SELECT COUNT(*) AS c FROM items ${where.length ? "WHERE " + where.join(" AND ") : ""}`).get(vals) as { c: number }).c;
}

export function getItem(id: string): ItemRow | undefined {
  return getDb().prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
}

export function listArticles(): ArticleRow[] {
  return getDb().prepare("SELECT * FROM articles ORDER BY fetched_at DESC").all() as ArticleRow[];
}

export function getArticle(id: string): ArticleRow | undefined {
  return getDb().prepare("SELECT * FROM articles WHERE id = ?").get(id) as ArticleRow | undefined;
}

export function typeCounts(): Record<string, number> {
  const rows = getDb().prepare("SELECT type, COUNT(*) AS c FROM items GROUP BY type").all() as { type: string; c: number }[];
  const out: Record<string, number> = { palette: 0, website: 0, repo: 0, prompt: 0, note: 0 };
  for (const r of rows) out[r.type] = r.c;
  return out;
}
