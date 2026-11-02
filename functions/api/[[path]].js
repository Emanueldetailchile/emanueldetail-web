
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

  if (path === "customer/chat" && req.method === "POST") {
    if (!env.AI || !env.DB) return json({ error: "El asistente no está disponible temporalmente. Escríbenos por WhatsApp al +56 9 3051 4998." }, 503);
    let body = {};
    try { body = await req.json(); } catch { return json({ error: "Mensaje no válido." }, 400); }
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 900) : "";
    if (!message) return json({ error: "Escribe tu consulta para continuar." }, 400);
    const history = Array.isArray(body.history) ? body.history.slice(-6).map(m => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: typeof m?.content === "string" ? m.content.slice(0, 500) : ""
    })).filter(m => m.content) : [];
    try {
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
      const ipKey = Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2,"0")).join("");
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS customer_ai_limits (ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL)").run();
      const now = Date.now();
      await env.DB.prepare("DELETE FROM customer_ai_limits WHERE created_at < ?").bind(now - 60 * 60 * 1000).run();
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM customer_ai_limits WHERE ip_hash=?").bind(ipKey).first();
      if (Number(count?.n || 0) >= 12) return json({ error: "Por ahora alcanzaste el límite de consultas. Escríbenos por WhatsApp al +56 9 3051 4998." }, 429);
      await env.DB.prepare("INSERT INTO customer_ai_limits(ip_hash,created_at) VALUES(?,?)").bind(ipKey, now).run();
      const localTime = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
      const system = `Eres el asistente virtual de EMANUELDETAIL, negocio chileno de detailing automotriz. Responde en español chileno natural, cordial y profesional, como una persona real de atención al cliente. Hora local de Santiago de Chile: ${localTime}.
REGLAS DE CONVERSACIÓN: si es el primer mensaje, saluda según la hora local (buenos días, buenas tardes o buenas noches); si ya existe conversación, no repitas el saludo. Responde primero a la pregunta concreta, no envíes un bloque publicitario ni un catálogo entero. Haz una sola pregunta útil cuando falte información. Mantén el contexto del vehículo y de lo que ya contó el cliente. No uses respuestas rígidas ni digas que eres una persona; puedes identificarte como asistente virtual si te preguntan.
CATÁLOGO CONFIRMADO DE VEHÍCULOS:
1) Pack de limpieza de tapiz: promoción de lanzamiento $30.000 CLP (precio de referencia $35.000). Incluye cielo, asientos delanteros y traseros, piso y alfombras. Duración estimada 1,5 horas; hasta 2 horas si está muy sucio.
2) Full interior: $50.000 CLP. Incluye cielo, asientos, piso, maletero, puertas, tablero/plásticos y ductos de ventilación; se trabaja con vapor, inyección de espuma y extracción. No incluye vidrios ni carrocería. Duración aproximada: 3 horas en sedán pequeño; 4 a 5 horas en vehículo grande, según estado.
3) Limpieza superficial de motor con vapor: $20.000 CLP. Duración aproximada 1 a 1,5 horas. Es superficial y no contempla desarme del motor.
OPERACIÓN: atención en nuestro espacio de trabajo en San Ramón, con reserva previa. No ofrecemos servicio a domicilio por ahora. Horario lunes a jueves 10:00–18:30; viernes 10:00–16:00; sábado y domingo no hay atención. Objetivo de capacidad: normalmente un servicio al día; máximo provisional dos si la agenda y los tiempos lo permiten. Una solicitud de hora NO es una reserva confirmada: siempre debe confirmarla una persona del equipo.
LÍMITES: no inventes precios, descuentos, disponibilidad, dirección exacta, garantías, resultados, cobertura ni servicios. Si preguntan por tapicería de hogar u otro trabajo no incluido en el catálogo activo, explica que requiere evaluación y ofrece derivar a una persona. No pidas datos sensibles, claves ni pagos. Si falta información, pregunta por modelo/tipo de vehículo o pide fotos cuando sea útil.
DERIVACIÓN HUMANA: marca handoff=true cuando el cliente pida hablar con una persona, reclame, negocie una condición especial, solicite un servicio fuera del catálogo, comparta una situación compleja o cuando no tengas certeza. En ese caso responde con naturalidad y explica que el equipo revisará su consulta.
FORMATO OBLIGATORIO: devuelve únicamente JSON válido con campos answer (respuesta al cliente), handoff (booleano) y handoff_reason (texto corto o vacío).`;
      const result = await env.AI.run("@cf/openai/gpt-oss-120b", {
        messages: [{ role: "system", content: system }, ...history, { role: "user", content: message }],
        max_tokens: 350
      });
      let raw = typeof result === "string" ? result : (result?.response || result?.result || result?.output_text || "");
      if (!raw && Array.isArray(result?.output)) {
        raw = result.output.flatMap(item => Array.isArray(item.content) ? item.content.filter(part => part.type === "output_text" || part.type === "text").map(part => part.text || "") : []).join("\\n");
      }
      if (!raw && result?.choices?.[0]?.message?.content) raw = result.choices[0].message.content;
      if (!raw || typeof raw !== "string") throw new Error("empty_model_response");
      let parsed;
      try {
        const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```\\s*$/, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = { answer: raw.trim(), handoff: true, handoff_reason: "Respuesta requiere revisión humana" };
      }
      const answer = String(parsed.answer || "").slice(0, 1400);
      if (!answer) throw new Error("empty_answer");
      return json({ ok: true, answer, handoff: parsed.handoff === true, handoff_reason: String(parsed.handoff_reason || "").slice(0, 180), provider: "Cloudflare Workers AI" });
    } catch {
      return json({ error: "No pude procesar tu consulta ahora. Puedes escribirnos directamente por WhatsApp al +56 9 3051 4998." }, 503);
    }
  }

  if (path === "marketing/ai-copy" && req.method === "POST") {
    if (!authorized(req, env)) return json({ error: "Autorización requerida. Inicia sesión como administrador." }, 401);
    if (!env.AI) return json({ error: "Falta activar el vínculo Workers AI llamado AI en Cloudflare Pages > Settings > Bindings. No se requiere API key." }, 503);
    let body = {};
    try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
    const allowedServices = new Set(["Pack de limpieza de tapiz","Full interior","Limpieza superficial de motor a vapor"]);
    const allowedObjectives = new Set(["Conseguir reservas","Mostrar resultados reales","Educar y generar confianza","Promocionar un servicio"]);
    const service = String(body.service || "");
    const commune = String(body.commune || "").slice(0, 80);
    const objective = String(body.objective || "");
    const offer = String(body.offer || "").slice(0, 180);
    const notes = String(body.notes || "").slice(0, 1200);
    const channels = Array.isArray(body.channels) ? body.channels.filter(x => ["Página de Facebook","Grupos de Facebook","Marketplace","Marketplace 1","Marketplace 2","Instagram"].includes(x)) : [];
    if (!allowedServices.has(service) || !allowedObjectives.has(objective) || !commune) return json({ error: "Servicio, comuna u objetivo no válido." }, 400);
    const instructions = "Eres el asistente de marketing de EMANUELDETAIL, negocio chileno de detailing automotriz. Escribe en español chileno natural, profesional y cercano. Genera SOLO el texto de una publicación listo para revisar, sin explicar tu proceso. No inventes testimonios, resultados, garantías, certificaciones, disponibilidad ni servicios a domicilio. Catálogo confirmado: Pack de limpieza de tapiz, promoción de lanzamiento $30.000 (referencia $35.000), incluye cielo, asientos delanteros y traseros, piso y alfombras; Full interior $50.000, incluye cielo, asientos, piso, maletero, puertas, tablero/plásticos y ductos de ventilación; no incluye vidrios ni carrocería; limpieza superficial de motor con vapor $20.000, no contempla desarme. Atención con reserva previa en nuestro espacio de trabajo en San Ramón. Horario lunes a jueves 10:00–18:30 y viernes 10:00–16:00. No ofrecemos domicilio actualmente. No presentes una oferta indicada por el administrador como precio oficial salvo que esté confirmada.";
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

  // Reservas: la solicitud pública queda pendiente; solo el administrador puede confirmarla.
  if (path === "bookings" && req.method === "POST") {
    let b = {};
    try { b = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
    const name = typeof b.name === "string" ? b.name.trim().slice(0,120) : "";
    const phone = typeof b.phone === "string" ? b.phone.trim().slice(0,40) : "";
    const service = typeof b.service === "string" ? b.service.trim().slice(0,160) : "";
    const commune = typeof b.commune === "string" ? b.commune.trim().slice(0,80) : "";
    const date = typeof b.date === "string" ? b.date : "";
    const start = typeof b.start === "string" ? b.start : "";
    if (!name || !phone || !service || !commune || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) return json({ error: "Completa nombre, teléfono, servicio, comuna, fecha y hora." }, 400);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS service_bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL, service TEXT NOT NULL, commune TEXT NOT NULL, booking_date TEXT NOT NULL, start_time TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pendiente', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
    const now = Date.now();
    const result = await env.DB.prepare("INSERT INTO service_bookings(name,phone,service,commune,booking_date,start_time,notes,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pendiente',?,?)").bind(name,phone,service,commune,date,start,String(b.notes||"").slice(0,700),now,now).run();
    return json({ ok: true, id: result.meta.last_row_id, status: "pendiente", message: "Solicitud recibida. La reserva queda pendiente de confirmación." }, 201);
  }

  if (path === "promotions" && req.method === "GET") {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS promotions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price INTEGER, starts_at TEXT, ends_at TEXT, max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0, code TEXT, status TEXT NOT NULL DEFAULT 'borrador', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
    if (authorized(req, env)) {
      const { results = [] } = await env.DB.prepare("SELECT * FROM promotions ORDER BY updated_at DESC LIMIT 200").all();
      return json(results);
    }
    const today = new Date().toISOString().slice(0,10);
    const { results = [] } = await env.DB.prepare("SELECT id,title,description,price,starts_at,ends_at,max_uses,used_count,code FROM promotions WHERE status='activa' AND (starts_at IS NULL OR starts_at='' OR starts_at<=?) AND (ends_at IS NULL OR ends_at='' OR ends_at>=?) AND (max_uses IS NULL OR used_count<max_uses) ORDER BY created_at DESC").bind(today,today).all();
    return json(results);
  }

  if (path === "contact" && req.method === "POST") {
    let b = {};
    try { b = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
    const name = typeof b.name === "string" ? b.name.trim().slice(0,120) : "";
    const contact = typeof b.contact === "string" ? b.contact.trim().slice(0,120) : "";
    const service = typeof b.service === "string" ? b.service.trim().slice(0,160) : "";
    const notes = typeof b.notes === "string" ? b.notes.trim().slice(0,900) : "";
    if (!name || !contact) return json({ error: "Indica tu nombre y un teléfono o correo de contacto." }, 400);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS marketing_leads (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, service TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'nuevo', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
    const now = Date.now();
    const result = await env.DB.prepare("INSERT INTO marketing_leads(name,contact,source,service,notes,status,created_at,updated_at) VALUES(?,?, 'web', ?, ?, 'nuevo', ?, ?)").bind(name,contact,service,notes,now,now).run();
    return json({ ok: true, id: result.meta.last_row_id, message: "Consulta recibida. EmanuelDetail se pondrá en contacto contigo." }, 201);
  }

  if (!authorized(req, env)) {
    return json(
      { error: "Debes iniciar sesión como administrador" },
      401
    );
  }

  if (path === "bookings" && req.method === "GET") {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS service_bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL, service TEXT NOT NULL, commune TEXT NOT NULL, booking_date TEXT NOT NULL, start_time TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pendiente', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
    const { results = [] } = await env.DB.prepare("SELECT * FROM service_bookings ORDER BY booking_date ASC,start_time ASC LIMIT 300").all();
    return json(results);
  }
  if (path.startsWith("bookings/") && req.method === "PATCH") {
    const id = Number(path.split("/")[1]);
    if (!Number.isInteger(id) || id < 1) return json({ error: "ID no válido." }, 400);
    let b = {}; try { b = await req.json(); } catch { return json({ error: "JSON inválido." }, 400); }
    const statuses = new Set(["pendiente","confirmada","reprogramacion","cancelada"]);
    if (!statuses.has(b.status)) return json({ error: "Estado de reserva no válido." }, 400);
    await env.DB.prepare("UPDATE service_bookings SET status=?,updated_at=? WHERE id=?").bind(b.status,Date.now(),id).run();
    return json({ ok: true });
  }
  if (path === "promotions" && req.method === "GET") {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS promotions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price INTEGER, starts_at TEXT, ends_at TEXT, max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0, code TEXT, status TEXT NOT NULL DEFAULT 'borrador', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
    const { results = [] } = await env.DB.prepare("SELECT * FROM promotions ORDER BY updated_at DESC LIMIT 200").all();
    return json(results);
  }
  if (path === "promotions" && req.method === "POST") {
    let b = {}; try { b = await req.json(); } catch { return json({ error: "JSON inválido." }, 400); }
    const title = typeof b.title === "string" ? b.title.trim().slice(0,120) : "";
    const description = typeof b.description === "string" ? b.description.trim().slice(0,700) : "";
    const price = b.price === null || b.price === "" || b.price === undefined ? null : Number(b.price);
    const maxUses = b.max_uses === null || b.max_uses === "" || b.max_uses === undefined ? null : Number(b.max_uses);
    const status = ["borrador","activa","pausada","vencida"].includes(b.status) ? b.status : "borrador";
    if (!title || (price !== null && (!Number.isSafeInteger(price) || price < 0)) || (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1))) return json({ error: "Título, precio o cupos no válidos." }, 400);
    const now = Date.now();
    const result = await env.DB.prepare("INSERT INTO promotions(title,description,price,starts_at,ends_at,max_uses,code,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(title,description,price,String(b.starts_at||"").slice(0,10),String(b.ends_at||"").slice(0,10),maxUses,String(b.code||"").trim().slice(0,40),status,now,now).run();
    return json({ ok: true, id: result.meta.last_row_id }, 201);
  }
  if (path.startsWith("promotions/") && req.method === "PATCH") {
    const id = Number(path.split("/")[1]);
    if (!Number.isInteger(id) || id < 1) return json({ error: "ID no válido." }, 400);
    let b = {}; try { b = await req.json(); } catch { return json({ error: "JSON inválido." }, 400); }
    const statuses = new Set(["borrador","activa","pausada","vencida"]);
    if (!statuses.has(b.status)) return json({ error: "Estado no válido." }, 400);
    await env.DB.prepare("UPDATE promotions SET status=?,updated_at=? WHERE id=?").bind(b.status,Date.now(),id).run();
    return json({ ok: true });
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
