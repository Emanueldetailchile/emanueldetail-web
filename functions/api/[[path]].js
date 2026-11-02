
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

  if (path === "marketing/ai-copy" && req.method === "POST") {
    if (!authorized(req, env)) return json({ error: "Autorización requerida. Inicia sesión como administrador." }, 401);
    if (!env.AI) return json({ error: "Falta activar el vínculo Workers AI llamado AI en Cloudflare Pages > Settings > Bindings. No se requiere API key." }, 503);
    let body = {};
    try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
    const allowedServices = new Set(["Limpieza interior de vehículos","Limpieza interior completa","Limpieza de tapicería de hogar","Pulido y abrillantado","Sellado cerámico","Limpieza de asientos","Otro servicio"]);
    const allowedObjectives = new Set(["Conseguir reservas","Mostrar resultados reales","Educar y generar confianza","Promocionar un servicio"]);
    const service = String(body.service || "");
    const commune = String(body.commune || "").slice(0, 80);
    const objective = String(body.objective || "");
    const offer = String(body.offer || "").slice(0, 180);
    const notes = String(body.notes || "").slice(0, 1200);
    const channels = Array.isArray(body.channels) ? body.channels.filter(x => ["Página de Facebook","Grupos de Facebook","Marketplace","Instagram"].includes(x)) : [];
    if (!allowedServices.has(service) || !allowedObjectives.has(objective) || !commune) return json({ error: "Servicio, comuna u objetivo no válido." }, 400);
    const instructions = "Eres el asistente de marketing de EMANUELDETAIL, negocio chileno de detailing automotriz y limpieza de tapicería. Escribe en español chileno natural, profesional y cercano. Genera SOLO el texto de una publicación listo para revisar, sin explicar tu proceso. No inventes testimonios, resultados, garantías, certificaciones, disponibilidad ni servicios a domicilio. Datos confirmados: promoción limpieza interior $35.000 incluye cielo, asientos y piso/alfombra; no incluye domicilio. Limpieza interior completa $50.000 incluye cielo, asientos, piso, puertas, tablero, maletero y ductos; no incluye vidrios ni carrocería y no es a domicilio. Tapicería hogar: sillón 2 cuerpos $25.000, futón $15.000, set 6 sillas $15.000 a $20.000, sillón 3/4 cuerpos L $35.000. Otros precios sujetos a evaluación por WhatsApp. Atención con reserva previa en San Ramón y comunas cercanas; cotización por WhatsApp +56 9 3051 4998. No presentes una oferta indicada como precio oficial salvo que esté confirmada.";
    const prompt = [instructions,"Servicio: "+service,"Comuna objetivo: "+commune,"Objetivo: "+objective,"Oferta indicada por el administrador: "+(offer || "Ninguna"),"Detalles aportados: "+(notes || "Ninguno"),"Canales previstos: "+(channels.join(", ") || "No especificados"),"Redacta una publicación persuasiva, clara y breve con llamado a cotizar por WhatsApp."].join("\n");
    try {
      const result = await env.AI.run("@cf/openai/gpt-oss-120b", {
        messages: [
          { role: "system", content: instructions + " Responde en español chileno. Nunca inventes precios ni condiciones." },
          { role: "user", content: [ "Servicio: "+service, "Comuna objetivo: "+commune, "Objetivo: "+objective, "Oferta indicada por el administrador: "+(offer || "Ninguna"), "Detalles aportados: "+(notes || "Ninguno"), "Canales previstos: "+(channels.join(", ") || "No especificados"), "Redacta una publicación persuasiva, clara y breve con llamado a cotizar por WhatsApp." ].join("\\n") }
        ],
        max_tokens: 450
      });
      const output = typeof result === "string" ? result : (result?.response || result?.result || "");
      if (!output || typeof output !== "string") return json({ error: "GPT-OSS-120B no devolvió texto utilizable." }, 502);
      return json({ ok: true, caption: output.trim(), provider: "Cloudflare Workers AI", model: "@cf/openai/gpt-oss-120b" });
    } catch {
      return json({ error: "GPT-OSS-120B no está disponible. En el plan gratuito, las solicitudes pueden detenerse al alcanzar la cuota diaria; no se usará OpenAI ni se activará facturación externa." }, 503);
    }
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


  if (path === "leads" && req.method === "GET") {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS marketing_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      service TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'nuevo',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`).run();
    const { results = [] } = await env.DB.prepare(
      "SELECT id,name,contact,source,service,notes,status,created_at,updated_at FROM marketing_leads ORDER BY updated_at DESC LIMIT 250"
    ).all();
    return json(results);
  }

  if (path === "leads" && req.method === "POST") {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS marketing_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      service TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'nuevo',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`).run();
    let b = {};
    try { b = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
    const name = typeof b.name === "string" ? b.name.trim().slice(0,120) : "";
    const contact = typeof b.contact === "string" ? b.contact.trim().slice(0,120) : "";
    const service = typeof b.service === "string" ? b.service.trim().slice(0,160) : "";
    const notes = typeof b.notes === "string" ? b.notes.trim().slice(0,1200) : "";
    const sources = new Set(["whatsapp","facebook","instagram","marketplace_1","marketplace_2","web","otro"]);
    const source = sources.has(b.source) ? b.source : "";
    if (!name || !source) return json({ error: "Nombre y canal de origen son obligatorios." }, 400);
    const now = Date.now();
    const result = await env.DB.prepare(
      "INSERT INTO marketing_leads(name,contact,source,service,notes,status,created_at,updated_at) VALUES(?,?,?,?,?,'nuevo',?,?)"
    ).bind(name,contact,source,service,notes,now,now).run();
    return json({ ok: true, id: result.meta.last_row_id }, 201);
  }

  if (path.startsWith("leads/") && req.method === "PATCH") {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS marketing_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      service TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'nuevo',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`).run();
    const id = Number(path.split("/")[1]);
    if (!Number.isInteger(id) || id < 1) return json({ error: "ID no válido." }, 400);
    let b = {};
    try { b = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
    const statuses = new Set(["nuevo","contactado","cotizado","agendado","ganado","perdido"]);
    if (b.status !== undefined && !statuses.has(b.status)) return json({ error: "Estado no válido." }, 400);
    const current = await env.DB.prepare("SELECT id FROM marketing_leads WHERE id=?").bind(id).first();
    if (!current) return json({ error: "Cliente potencial no encontrado." }, 404);
    const fields = ["status","notes","service","contact"];
    const sets = [], values = [];
    for (const field of fields) {
      if (b[field] !== undefined) {
        if (field === "status" && !statuses.has(b[field])) continue;
        if (typeof b[field] !== "string") return json({ error: "Campo no válido: " + field }, 400);
        sets.push(field + "=?");
        values.push(b[field].trim().slice(0, field === "notes" ? 1200 : 160));
      }
    }
    if (!sets.length) return json({ error: "No hay cambios válidos." }, 400);
    sets.push("updated_at=?");
    values.push(Date.now(), id);
    await env.DB.prepare("UPDATE marketing_leads SET " + sets.join(",") + " WHERE id=?").bind(...values).run();
    return json({ ok: true });
  }

  return json({ error: "Ruta no encontrada" }, 404);
}
