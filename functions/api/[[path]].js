
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

function authorized(req, env) {
  const h = req.headers.get("Authorization") || "";
  const expected = String(env.ADMIN_TOKEN || "").trim();
  return !!expected && h === `Bearer ${expected}`;
}

export async function onRequest(context) {
  const { request: req, env } = context;
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "");

  if (path === "health" && req.method === "GET") {
    return json({
      ok: true,
      db: !!env.DB,
      images: !!env.IMAGES,
      adminConfigured: !!env.ADMIN_TOKEN,
    });
  }

  if (path === "login" && req.method === "POST") {
    let b = {};
    try {
      b = await req.json();
    } catch {
      return json({ error: "Solicitud inválida" }, 400);
    }

    const received =
      typeof b.token === "string" ? b.token.trim() : "";
    const expected = String(env.ADMIN_TOKEN || "").trim();

    if (!expected) {
      return json(
        {
          error:
            "Falta configurar ADMIN_TOKEN en Pages > Settings > Variables and Secrets",
        },
        503
      );
    }

    if (received && received === expected) {
      return json({ ok: true });
    }

    return json({ error: "Clave incorrecta" }, 401);
  }

  if (!env.DB) {
    return json(
      { error: "No está vinculada la base D1 (binding DB)" },
      503
    );
  }

  if (path === "site-images" && req.method === "GET") {
    const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key=?").bind("site_images").first();
    let images = {};
    if (row && row.value) {
      try { images = JSON.parse(row.value); } catch { images = {}; }
    }
    return json(images);
  }

  if (path === "site-images" && req.method === "PUT") {
    if (!authorized(req, env)) {
      return json({ error: "Debes iniciar sesión como administrador" }, 401);
    }
    let body = {};
    try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
    const allowed = new Set(["home_1","home_2","home_3","home_4","gallery_1","gallery_2","gallery_3","product_1","product_2","product_3","product_4"]);
    if (!body || typeof body.images !== "object" || Array.isArray(body.images)) {
      return json({ error: "Se esperaba un objeto de imágenes" }, 400);
    }
    const images = {};
    for (const [key, value] of Object.entries(body.images)) {
      if (!allowed.has(key)) continue;
      if (typeof value === "string" && value.length <= 2048) images[key] = value;
    }
    await env.DB.prepare("INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind("site_images", JSON.stringify(images)).run();
    return json({ ok: true, images });
  }

  if (path === "gallery" && req.method === "GET") {
    const { results = [] } = await env.DB
      .prepare(
        "SELECT id,image_url,caption,created_at FROM gallery ORDER BY id DESC"
      )
      .all();
    return json(results);
  }

  if (path === "products" && req.method === "GET") {
    const { results = [] } = await env.DB
      .prepare(
        "SELECT id,name,price,category,description,image_url,payment_url,active,created_at FROM products WHERE active=1 ORDER BY id DESC"
      )
      .all();
    return json(results);
  }

  if (!authorized(req, env)) {
    return json(
      { error: "Debes iniciar sesión como administrador" },
      401
    );
  }

  if (path === "gallery" && req.method === "POST") {
    const b = await req.json();

    if (!b.image_url) {
      return json({ error: "Falta la URL de la imagen" }, 400);
    }

    const r = await env.DB
      .prepare(
        "INSERT INTO gallery(image_url,caption,created_at) VALUES(?,?,?)"
      )
      .bind(b.image_url, b.caption || "", Date.now())
      .run();

    return json({ ok: true, id: r.meta.last_row_id }, 201);
  }

  if (path.startsWith("gallery/") && req.method === "DELETE") {
    const id = Number(path.split("/")[1]);
    await env.DB.prepare("DELETE FROM gallery WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  if (path === "products" && req.method === "POST") {
    const b = await req.json();

    if (!b.name) {
      return json({ error: "Falta el nombre del producto" }, 400);
    }

    const r = await env.DB
      .prepare(
        "INSERT INTO products(name,price,category,description,image_url,payment_url,active,created_at) VALUES(?,?,?,?,?,?,?,?)"
      )
      .bind(
        b.name,
        b.price || "",
        b.category || "",
        b.description || "",
        b.image_url || "",
        b.payment_url || "",
        b.active === false ? 0 : 1,
        Date.now()
      )
      .run();

    return json({ ok: true, id: r.meta.last_row_id }, 201);
  }

  if (path.startsWith("products/") && req.method === "DELETE") {
    const id = Number(path.split("/")[1]);
    await env.DB.prepare("DELETE FROM products WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  if (path === "upload" && req.method === "POST") {
    if (!env.IMAGES) {
      return json(
        { error: "Falta vincular R2 con el binding IMAGES" },
        503
      );
    }

    const form = await req.formData();
    const file = form.get("file");

    if (!file || typeof file === "string") {
      return json({ error: "Selecciona una imagen" }, 400);
    }

    if (!file.type.startsWith("image/")) {
      return json({ error: "Solo se permiten imágenes" }, 400);
    }

    if (file.size > 8 * 1024 * 1024) {
      return json({ error: "Máximo 8 MB por imagen" }, 413);
    }

    const ext =
      (file.name.split(".").pop() || "jpg")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase() || "jpg";

    const key = `uploads/${crypto.randomUUID()}.${ext}`;

    await env.IMAGES.put(key, file.stream(), {
      httpMetadata: { contentType: file.type },
    });

    const base = String(env.R2_PUBLIC_URL || "").replace(/\/$/, "");
    const publicUrl = base ? `${base}/${key}` : null;

    return json({ ok: true, key, publicUrl }, 201);
  }

  return json({ error: "Ruta no encontrada" }, 404);
}
