CREATE TABLE IF NOT EXISTS gallery (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 image_url TEXT NOT NULL,
 caption TEXT DEFAULT '',
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 price TEXT DEFAULT '',
 category TEXT DEFAULT '',
 description TEXT DEFAULT '',
 image_url TEXT DEFAULT '',
 payment_url TEXT DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS site_settings (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS site_visitors (
 visitor_id TEXT PRIMARY KEY,
 first_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS site_visits (
 visit_id TEXT PRIMARY KEY,
 visitor_id TEXT NOT NULL,
 visited_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS marketing_leads (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 contact TEXT NOT NULL DEFAULT '',
 source TEXT NOT NULL,
 service TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'nuevo',
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketing_leads_updated ON marketing_leads(updated_at DESC);
