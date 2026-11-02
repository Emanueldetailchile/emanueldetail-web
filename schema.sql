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


CREATE TABLE IF NOT EXISTS service_bookings (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 phone TEXT NOT NULL,
 service TEXT NOT NULL,
 commune TEXT NOT NULL,
 booking_date TEXT NOT NULL,
 start_time TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pendiente',
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_bookings_schedule
 ON service_bookings(booking_date, start_time, status);

CREATE TABLE IF NOT EXISTS promotions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 price INTEGER,
 starts_at TEXT,
 ends_at TEXT,
 max_uses INTEGER,
 used_count INTEGER NOT NULL DEFAULT 0,
 code TEXT,
 status TEXT NOT NULL DEFAULT 'borrador',
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promotions_status_dates
 ON promotions(status, starts_at, ends_at);
