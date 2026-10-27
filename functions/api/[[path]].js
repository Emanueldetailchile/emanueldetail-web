
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

  if (path === "store-config" && req.method === "GET") {
    const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key=?").bind("store_config").first();
    let config = {};
    if (row && row.value) { try { config = JSON.parse(row.value); } catch { config = {}; } }
    return json({ bankName: config.bankName || "", accountHolder: config.accountHolder || "", taxId: config.taxId || "", accountType: config.accountType || "", accountNumber: config.accountNumber || "", bankEmail: config.bankEmail || "", cardPaymentEnabled: false });
  }

  if (path === "orders" && req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch { return json({ error: "Solicitud inválida" }, 400); }
    const c = body.customer || {};
    if (!c.name || !c.email || !c.phone || !c.address) return json({ error: "Completa nombre, correo, teléfono y dirección." }, 400);
    if (!["transferencia", "tarjeta"].includes(body.paymentMethod)) return json({ error: "Forma de pago no válida." }, 400);
    if (body.paymentMethod === "tarjeta") return json({ error: "Pago con tarjeta aún no habilitado. Primero hay que integrar y probar una pasarela segura con credenciales comerciales." }, 409);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 40) return json({ error: "El carrito está vacío o contiene demasiados productos." }, 400);
    const cleanItems = [];
    let total = 0;
    for (const item of body.items) {
      const id = Number(item.productId), qty = Number(item.quantity);
      if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 25) return json({ error: "Cantidad o producto no válido." }, 400);
      const product = await env.DB.prepare("SELECT id,name,price,active FROM products WHERE id=? AND active=1").bind(id).first();
      if (!product) return json({ error: "Uno de los productos ya no está disponible. Actualiza el catálogo." }, 409);
      const price = Number(String(product.price || "").replace(/[^0-9]/g, ""));
      if (!Number.isSafeInteger(price) || price <= 0) return json({ error: "El producto " + product.name + " aún no tiene precio válido." }, 409);
      total += price * qty;
      cleanItems.push({ productId: id, name: product.name, price, quantity: qty });
    }
    if (!Number.isSafeInteger(total) || total > 100000000) return json({ error: "Total fuera de rango." }, 400);
    const cfgRow = await env.DB.prepare("SELECT value FROM site_settings WHERE key=?").bind("store_config").first();
    let cfg = {}; try { cfg = JSON.parse(cfgRow?.value || "{}"); } catch { cfg = {}; }
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS store_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_number TEXT NOT NULL UNIQUE, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT NOT NULL, customer_address TEXT NOT NULL, payment_method TEXT NOT NULL, items_json TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pendiente_transferencia', created_at INTEGER NOT NULL)").run();
    const orderNumber = "ED-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomUUID().slice(0, 4).toUpperCase();
    await env.DB.prepare("INSERT INTO store_orders(order_number,customer_name,customer_email,customer_phone,customer_address,payment_method,items_json,total,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(orderNumber, String(c.name).slice(0,160), String(c.email).slice(0,200), String(c.phone).slice(0,50), String(c.address).slice(0,500), "transferencia", JSON.stringify(cleanItems), total, "pendiente_transferencia", Date.now()).run();
    return json({ ok: true, orderNumber, total, status: "pendiente_transferencia", bankDetails: { bankName: cfg.bankName || "", accountHolder: cfg.accountHolder || "", taxId: cfg.taxId || "", accountType: cfg.accountType || "", accountNumber: cfg.accountNumber || "", bankEmail: cfg.bankEmail || "" } }, 201);
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

  if (path === "store-config" && req.method === "PUT") {
    let body = {};
    try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
    const fields = ["bankName","accountHolder","taxId","accountType","accountNumber","bankEmail"];
    const config = {};
    for (const field of fields) config[field] = typeof body[field] === "string" ? body[field].trim().slice(0,200) : "";
    await env.DB.prepare("INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind("store_config", JSON.stringify(config)).run();
    return json({ ok: true, config });
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
