const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function cookieValue(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  const found = cookies.split(";").map(v => v.trim()).find(v => v.startsWith(name + "="));
  return found ? found.slice(name.length + 1) : "";
}

function makeId() {
  return crypto.randomUUID().replace(/-/g, "");
}

async function ensureTables(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS site_visitors (visitor_id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS site_visits (visit_id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL, visited_at INTEGER NOT NULL)")
  ]);
}

export async function onRequest({ request, env }) {
  if (!env.DB) return json({ error: "Base de datos no disponible" }, 503);
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }

  try {
    await ensureTables(env.DB);
    if (request.method === "POST") {
      let visitorId = cookieValue(request, "ed_vid");
      let newVisitor = !/^[a-f0-9]{32}$/.test(visitorId);
      if (newVisitor) visitorId = makeId();

      // One counted visit per browser session; refreshes in the same session do not inflate totals.
      let sessionId = cookieValue(request, "ed_sid");
      const newSession = !/^[a-f0-9]{32}$/.test(sessionId);
      if (newSession) sessionId = makeId();

      const now = Date.now();
      if (newVisitor) {
        await env.DB.prepare("INSERT OR IGNORE INTO site_visitors(visitor_id, first_seen) VALUES(?,?)").bind(visitorId, now).run();
      }
      if (newSession) {
        await env.DB.prepare("INSERT OR IGNORE INTO site_visits(visit_id, visitor_id, visited_at) VALUES(?,?,?)").bind(sessionId, visitorId, now).run();
      }

      const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      headers.append("Set-Cookie", `ed_vid=${visitorId}; Max-Age=31536000; Path=/; Secure; SameSite=Lax; HttpOnly`);
      if (newSession) headers.append("Set-Cookie", `ed_sid=${sessionId}; Path=/; Secure; SameSite=Lax; HttpOnly`);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    const [visitors, visits] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total FROM site_visitors").first(),
      env.DB.prepare("SELECT COUNT(*) AS total FROM site_visits").first()
    ]);
    return json({ uniqueVisitors: Number(visitors?.total || 0), totalVisits: Number(visits?.total || 0) });
  } catch (error) {
    return json({ error: "No se pudieron consultar las estadísticas" }, 500);
  }
}
