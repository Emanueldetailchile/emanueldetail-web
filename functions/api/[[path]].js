
const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });

function cookieName(scope) { return scope === "marketing" ? "ed_marketing_session" : "ed_site_session"; }
function cookieValue(req, name) {
  const raw = req.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}
function bytesHex(bytes) { return Array.from(new Uint8Array(bytes)).map(x => x.toString(16).padStart(2,"0")).join(""); }
async function sha256(value) { return bytesHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
async function passwordHash(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(x => parseInt(x,16)));
  const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:210000,hash:"SHA-256"},key,256);
  return bytesHex(bits);
}
async function ensureAuthTables(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_accounts (scope TEXT PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL DEFAULT '', salt TEXT NOT NULL DEFAULT '', must_change INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_reset_tokens (token_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_login_attempts (ip_hash TEXT NOT NULL, scope TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(ip_hash,scope))").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_reset_attempts (ip_hash TEXT NOT NULL, scope TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(ip_hash,scope))").run();
}
async function sessionInfo(req, env, scope) {
  if (!env.DB) return null;
  await ensureAuthTables(env);
  const token = cookieValue(req,cookieName(scope));
  if (!token) return null;
  const tokenHash = await sha256(token), now = Date.now();
  const session = await env.DB.prepare("SELECT token_hash FROM admin_sessions WHERE token_hash=? AND scope=? AND expires_at>?").bind(tokenHash,scope,now).first();
  if (!session) return null;
  const account = await env.DB.prepare("SELECT must_change FROM admin_accounts WHERE scope=?").bind(scope).first();
  if (!account) return null;
  return {scope,mustChange:Number(account.must_change)===1};
}
async function authorized(req, env, scope = "site") {
  const session = await sessionInfo(req,env,scope);
  return !!session && !session.mustChange;
}
async function issueSession(env,scope) {
  const token = randomToken(), tokenHash = await sha256(token), now = Date.now();
  await env.DB.prepare("INSERT INTO admin_sessions(token_hash,scope,expires_at,created_at) VALUES(?,?,?,?)").bind(tokenHash,scope,now+8*60*60*1000,now).run();
  return {token,cookie:cookieName(scope)+"="+token+"; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=28800"};
}
function clearSessionCookie(scope) {
  return cookieName(scope)+"=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

export async function onRequest(context) {
  const { request: req, env } = context;
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "");


  if (path.startsWith("auth/")) {
    if (!env.DB) return json({error:"Base de datos no disponible."},503);
    await ensureAuthTables(env);
    const body = async () => { try { return await req.json(); } catch { return null; } };
    if (path === "auth/me" && req.method === "GET") {
      const scope = url.searchParams.get("scope") === "marketing" ? "marketing" : "site";
      const info = await sessionInfo(req,env,scope);
      return json({ok:true,loggedIn:!!info,mustChange:!!info?.mustChange,scope});
    }
    if (path === "auth/login" && req.method === "POST") {
      const b = await body();
      if (!b) return json({error:"Solicitud inválida."},400);
      const scope = b.scope === "marketing" ? "marketing" : "site";
      const password = typeof b.password === "string" ? b.password : "";
      if (!password || password.length > 200) return json({error:"Ingresa la clave temporal o tu contraseña."},400);
      const bootstrapName = scope === "marketing" ? "MARKETING_ADMIN_BOOTSTRAP" : "SITE_ADMIN_BOOTSTRAP";
      const bootstrap = String(env[bootstrapName] || "");
      const now = Date.now(), ipHash = await sha256(req.headers.get("CF-Connecting-IP") || "unknown");
      const attempt = await env.DB.prepare("SELECT window_start,count FROM admin_login_attempts WHERE ip_hash=? AND scope=?").bind(ipHash,scope).first();
      if (attempt && Number(attempt.window_start) > now-15*60*1000 && Number(attempt.count) >= 8) return json({error:"Demasiados intentos. Espera 15 minutos e inténtalo nuevamente."},429);
      if (!attempt || Number(attempt.window_start) <= now-15*60*1000) {
        await env.DB.prepare("INSERT INTO admin_login_attempts(ip_hash,scope,window_start,count) VALUES(?,?,?,1) ON CONFLICT(ip_hash,scope) DO UPDATE SET window_start=excluded.window_start,count=1").bind(ipHash,scope,now).run();
      } else {
        await env.DB.prepare("UPDATE admin_login_attempts SET count=count+1 WHERE ip_hash=? AND scope=?").bind(ipHash,scope).run();
      }
      const account = await env.DB.prepare("SELECT scope,email,password_hash,salt,must_change FROM admin_accounts WHERE scope=?").bind(scope).first();
      let mustChange = false;
      if (!account) {
        if (!bootstrap) return json({error:"Falta configurar la clave provisional segura en Cloudflare Preview."},503);
        if (password !== bootstrap) return json({error:"Clave incorrecta."},401);
        const email = String(env.ADMIN_RECOVERY_EMAIL || "emanueldetailchile@gmail.com").toLowerCase();
        await env.DB.prepare("INSERT OR IGNORE INTO admin_accounts(scope,email,password_hash,salt,must_change,created_at,updated_at) VALUES(?,?, '', '',1,?,?)").bind(scope,email,now,now).run();
        mustChange = true;
      } else if (Number(account.must_change) === 1) {
        if (!bootstrap || password !== bootstrap) return json({error:"Debes usar la clave provisional para completar la configuración inicial."},401);
        mustChange = true;
      } else {
        const valid = account.salt && account.password_hash && await passwordHash(password,account.salt) === account.password_hash;
        if (!valid) return json({error:"Clave incorrecta."},401);
      }
      await env.DB.prepare("DELETE FROM admin_login_attempts WHERE ip_hash=? AND scope=?").bind(ipHash,scope).run();
      const issued = await issueSession(env,scope);
      return json({ok:true,scope,mustChange},200,{"Set-Cookie":issued.cookie});
    }
    if (path === "auth/change-password" && req.method === "POST") {
      const b = await body();
      const scope = b?.scope === "marketing" ? "marketing" : "site";
      const info = await sessionInfo(req,env,scope);
      if (!info || !info.mustChange) return json({error:"No hay una configuración inicial pendiente."},401);
      const password = typeof b?.password === "string" ? b.password : "";
      if (password.length < 12 || password.length > 200) return json({error:"La nueva contraseña debe tener al menos 12 caracteres."},400);
      const bootstrapName = scope === "marketing" ? "MARKETING_ADMIN_BOOTSTRAP" : "SITE_ADMIN_BOOTSTRAP";
      const bootstrap = String(env[bootstrapName] || "");
      if (bootstrap && password === bootstrap) return json({error:"La contraseña definitiva debe ser distinta de la clave provisional."},400);
      const salt = bytesHex(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await passwordHash(password,salt), now = Date.now();
      await env.DB.prepare("UPDATE admin_accounts SET password_hash=?,salt=?,must_change=0,updated_at=? WHERE scope=?").bind(hash,salt,now,scope).run();
      return json({ok:true,message:"Contraseña definitiva guardada. La clave provisional dejó de servir."});
    }
    if (path === "auth/logout" && req.method === "POST") {
      const b = await body();
      const scope = b?.scope === "marketing" ? "marketing" : "site";
      const token = cookieValue(req,cookieName(scope));
      if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=? AND scope=?").bind(await sha256(token),scope).run();
      return json({ok:true},200,{"Set-Cookie":clearSessionCookie(scope)});
    }
    if (path === "auth/request-reset" && req.method === "POST") {
      const b = await body();
      const scope = b?.scope === "marketing" ? "marketing" : "site";
      const email = String(b?.email || "").trim().toLowerCase().slice(0,200);
      const recoveryEmail = String(env.ADMIN_RECOVERY_EMAIL || "emanueldetailchile@gmail.com").toLowerCase();
      const now = Date.now();
      const ipHash = await sha256(req.headers.get("CF-Connecting-IP") || "unknown");
      const resetAttempt = await env.DB.prepare("SELECT window_start,count FROM admin_reset_attempts WHERE ip_hash=? AND scope=?").bind(ipHash,scope).first();
      if (resetAttempt && Number(resetAttempt.window_start) > now-15*60*1000 && Number(resetAttempt.count) >= 3) {
        return json({error:"Se alcanzó el límite de recuperación. Espera 15 minutos antes de intentarlo nuevamente."},429);
      }
      if (!resetAttempt || Number(resetAttempt.window_start) <= now-15*60*1000) {
        await env.DB.prepare("INSERT INTO admin_reset_attempts(ip_hash,scope,window_start,count) VALUES(?,?,?,1) ON CONFLICT(ip_hash,scope) DO UPDATE SET window_start=excluded.window_start,count=1").bind(ipHash,scope,now).run();
      } else {
        await env.DB.prepare("UPDATE admin_reset_attempts SET count=count+1 WHERE ip_hash=? AND scope=?").bind(ipHash,scope).run();
      }
      if (email !== recoveryEmail) return json({ok:true,message:"Si los datos corresponden, recibirás instrucciones en el correo registrado."});
      if (!env.RESEND_API_KEY) return json({error:"La recuperación por correo aún no está habilitada. Falta configurar RESEND_API_KEY en Cloudflare Preview."},503);
      const account = await env.DB.prepare("SELECT scope FROM admin_accounts WHERE scope=? AND email=?").bind(scope,recoveryEmail).first();
      if (!account) return json({ok:true,message:"Si los datos corresponden, recibirás instrucciones en el correo registrado."});
      const rawToken = randomToken(), tokenHash = await sha256(rawToken);
      await env.DB.prepare("DELETE FROM admin_reset_tokens WHERE scope=? OR expires_at<?").bind(scope,now).run();
      await env.DB.prepare("INSERT INTO admin_reset_tokens(token_hash,scope,expires_at,used_at,created_at) VALUES(?,?,?,NULL,?)").bind(tokenHash,scope,now+20*60*1000,now).run();
      const resetUrl = new URL(scope === "marketing" ? "/marketing/" : "/admin.html",url.origin);
      resetUrl.searchParams.set("reset",rawToken);
      resetUrl.searchParams.set("scope",scope);
      const emailResponse = await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+env.RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:env.EMAIL_FROM || "onboarding@resend.dev",to:[recoveryEmail],subject:"Recuperar acceso EMANUELDETAIL",html:"<p>Se solicitó restablecer el acceso de EMANUELDETAIL ("+scope+").</p><p><a href=\""+resetUrl.toString()+"\">Crear una nueva contraseña</a></p><p>Este enlace vence en 20 minutos y solo puede usarse una vez. Si no solicitaste el cambio, ignora este mensaje.</p>"})});
      if (!emailResponse.ok) {
        await env.DB.prepare("DELETE FROM admin_reset_tokens WHERE token_hash=?").bind(tokenHash).run();
        return json({error:"No pudimos enviar el correo de recuperación. Revisa la configuración del proveedor de correo."},502);
      }
      return json({ok:true,message:"Si los datos corresponden, recibirás instrucciones en el correo registrado."});
    }
    if (path === "auth/reset-password" && req.method === "POST") {
      const b = await body();
      const scope = b?.scope === "marketing" ? "marketing" : "site";
      const token = typeof b?.token === "string" ? b.token : "";
      const password = typeof b?.password === "string" ? b.password : "";
      if (!token || password.length < 12 || password.length > 200) return json({error:"Enlace o contraseña no válidos. La contraseña debe tener al menos 12 caracteres."},400);
      const bootstrapName = scope === "marketing" ? "MARKETING_ADMIN_BOOTSTRAP" : "SITE_ADMIN_BOOTSTRAP";
      const bootstrap = String(env[bootstrapName] || "");
      if (bootstrap && password === bootstrap) return json({error:"La contraseña definitiva debe ser distinta de la clave provisional."},400);
      const tokenHash = await sha256(token), now = Date.now();
      const reset = await env.DB.prepare("SELECT token_hash FROM admin_reset_tokens WHERE token_hash=? AND scope=? AND expires_at>? AND used_at IS NULL").bind(tokenHash,scope,now).first();
      if (!reset) return json({error:"El enlace venció o ya fue utilizado. Solicita uno nuevo."},400);
      const salt = bytesHex(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await passwordHash(password,salt);
      await env.DB.prepare("UPDATE admin_accounts SET password_hash=?,salt=?,must_change=0,updated_at=? WHERE scope=?").bind(hash,salt,now,scope).run();
      await env.DB.prepare("UPDATE admin_reset_tokens SET used_at=? WHERE token_hash=?").bind(now,tokenHash).run();
      await env.DB.prepare("DELETE FROM admin_sessions WHERE scope=?").bind(scope).run();
      return json({ok:true,message:"Contraseña actualizada. Ya puedes iniciar sesión."});
    }
    return json({error:"Ruta de autenticación no encontrada."},404);
  }

  if (path === "health" && req.method === "GET") {
    return json({
      ok: true,
      db: !!env.DB,
      images: !!env.IMAGES,
      adminConfigured: !!(env.SITE_ADMIN_BOOTSTRAP && env.MARKETING_ADMIN_BOOTSTRAP),
      siteAdminConfigured: !!env.SITE_ADMIN_BOOTSTRAP,
      marketingAdminConfigured: !!env.MARKETING_ADMIN_BOOTSTRAP,
      recoveryEmailConfigured: !!env.RESEND_API_KEY,
    });
  }

  if (path === "login" && req.method === "POST") {
    return json({error:"El acceso anterior fue retirado. Usa el inicio de sesión seguro."},410);
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

  if (path === "marketing/upload" && req.method === "POST") {
    if (!(await authorized(req, env, "marketing"))) return json({ error: "Debes iniciar sesión en Marketing IA." }, 401);
    if (!env.IMAGES) return json({ error: "El almacenamiento de imágenes no está disponible." }, 503);
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return json({ error: "Selecciona una imagen." }, 400);
    const allowed = new Map([["image/jpeg","jpg"],["image/png","png"],["image/webp","webp"]]);
    const ext = allowed.get(file.type);
    if (!ext) return json({ error: "Formato no permitido. Usa JPG, PNG o WebP." }, 415);
    if (file.size < 1 || file.size > 8 * 1024 * 1024) return json({ error: "La imagen debe pesar como máximo 8 MB." }, 413);
    const key = "marketing/" + crypto.randomUUID() + "." + ext;
    await env.IMAGES.put(key, file.stream(), { httpMetadata: { contentType: file.type, cacheControl: "public, max-age=31536000, immutable" } });
    const base = String(env.R2_PUBLIC_URL || "").replace(/\/$/, "");
    if (!base) return json({ error: "Falta configurar R2_PUBLIC_URL." }, 503);
    return json({ ok: true, key, publicUrl: base + "/" + key }, 201);
  }

  if (path === "marketing/ai-copy" && req.method === "POST") {
    if (!(await authorized(req, env, "marketing"))) return json({ error: "Autorización requerida. Inicia sesión en Marketing IA." }, 401);
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
    if (!(await authorized(req, env, "site"))) {
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

  if (path === "customer/content" && req.method === "GET") {
    const { results: gallery = [] } = await env.DB.prepare("SELECT id,image_url,caption,created_at FROM gallery ORDER BY id DESC LIMIT 60").all();
    const imageRow = await env.DB.prepare("SELECT value FROM site_settings WHERE key=?").bind("site_images").first();
    let siteImages = {}; try { siteImages = JSON.parse(imageRow?.value || "{}"); } catch { siteImages = {}; }
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS promotions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price INTEGER, starts_at TEXT, ends_at TEXT, max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0, code TEXT, status TEXT NOT NULL DEFAULT 'borrador', audience TEXT NOT NULL DEFAULT 'all', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
    try { await env.DB.prepare("ALTER TABLE promotions ADD COLUMN audience TEXT NOT NULL DEFAULT 'all'").run(); } catch {}
    const today = new Intl.DateTimeFormat("en-CA", {timeZone:"America/Santiago",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    const { results: promotions = [] } = await env.DB.prepare("SELECT id,title,description,price,starts_at,ends_at,max_uses,used_count,code,audience FROM promotions WHERE audience IN ('all','app') AND status='activa' AND (starts_at IS NULL OR starts_at='' OR starts_at<=?) AND (ends_at IS NULL OR ends_at='' OR ends_at>=?) AND (max_uses IS NULL OR used_count<max_uses) ORDER BY created_at DESC").bind(today,today).all();
    const services = [
      {id:"pack-tapiz",name:"Pack de limpieza de tapiz",price:30000,referencePrice:35000,duration:"1,5 a 2 horas",description:"Cielo, asientos delanteros y traseros, piso y alfombras."},
      {id:"full-interior",name:"Full interior",price:50000,duration:"3 a 5 horas",description:"Cielo, asientos, piso, maletero, puertas, tablero, plásticos y ductos de ventilación."},
      {id:"motor-vapor",name:"Limpieza superficial de motor a vapor",price:20000,duration:"1 a 1,5 horas",description:"Limpieza superficial con vapor. No contempla desarme del motor."}
    ];
    return json({ok:true,services,gallery,promotions,siteImages,location:"San Ramón, Santiago",hours:{mondayToThursday:"10:00–18:30",friday:"10:00–16:00"},bookingPolicy:"Toda solicitud queda pendiente de confirmación humana."});
  }

  // Reservas: la solicitud pública queda pendiente; solo el administrador puede confirmarla.
  if (path === "bookings" && req.method === "POST") {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS booking_attempts (ip_hash TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)").run();
    const nowForLimit = Date.now();
    const bookingIpHash = await sha256(req.headers.get("CF-Connecting-IP") || "unknown");
    const bookingAttempt = await env.DB.prepare("SELECT window_start,count FROM booking_attempts WHERE ip_hash=?").bind(bookingIpHash).first();
    if (bookingAttempt && Number(bookingAttempt.window_start) > nowForLimit-60*60*1000 && Number(bookingAttempt.count) >= 6) {
      return json({error:"Se alcanzó el límite de solicitudes de reserva. Intenta nuevamente más tarde o contáctanos por WhatsApp."},429);
    }
    if (!bookingAttempt || Number(bookingAttempt.window_start) <= nowForLimit-60*60*1000) {
      await env.DB.prepare("INSERT INTO booking_attempts(ip_hash,window_start,count) VALUES(?,?,1) ON CONFLICT(ip_hash) DO UPDATE SET window_start=excluded.window_start,count=1").bind(bookingIpHash,nowForLimit).run();
    } else {
      await env.DB.prepare("UPDATE booking_attempts SET count=count+1 WHERE ip_hash=?").bind(bookingIpHash).run();
    }
    let b = {};
    try { b = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
    const name = typeof b.name === "string" ? b.name.trim().slice(0,120) : "";
    const phone = typeof b.phone === "string" ? b.phone.trim().slice(0,40) : "";
    const service = typeof b.service === "string" ? b.service.trim() : "";
    const commune = typeof b.commune === "string" ? b.commune.trim().slice(0,80) : "San Ramón";
    const date = typeof b.date === "string" ? b.date : "";
    const start = typeof b.start === "string" ? b.start : "";
    const notes = ("Origen: " + (b.source === "app" ? "App clientes" : "Web") + ". " + String(b.notes || "")).slice(0,700);
    const requestedDuration = (serviceName, bookingNotes) => {
      const heavy = /estado:\s*heavy/i.test(bookingNotes);
      const large = /Vehículo:\s*large/i.test(bookingNotes);
      if (serviceName === "Pack de limpieza de tapiz") return heavy ? 120 : 90;
      if (serviceName === "Full interior") return large ? (heavy ? 300 : 240) : 180;
      if (serviceName === "Limpieza superficial de motor a vapor") return heavy ? 90 : 60;
      return 0;
    };
    const duration = requestedDuration(service, notes);
    if (!name || !phone || !duration || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) return json({ error: "Completa nombre, teléfono, servicio, fecha y hora válida." }, 400);
    const dateObj = new Date(date + "T12:00:00Z");
    if (Number.isNaN(dateObj.getTime()) || dateObj.toISOString().slice(0,10) !== date) return json({error:"Fecha no válida."},400);
    const weekday = dateObj.getUTCDay();
    if (weekday === 0 || weekday === 6) return json({error:"No atendemos sábados ni domingos."},400);
    const [hh,mm] = start.split(":").map(Number);
    const startMinutes = hh*60+mm, endMinutes = startMinutes+duration;
    const closing = weekday === 5 ? 16*60 : 18*60+30;
    if ((weekday >= 1 && weekday <= 4 && startMinutes < 10*60) || (weekday === 5 && startMinutes < 10*60) || endMinutes > closing) return json({error:"Ese horario queda fuera de nuestra jornada o no alcanza para completar el servicio."},400);
    const today = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Santiago",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    if (date < today) return json({error:"No puedes solicitar una fecha pasada."},400);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS service_bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL, service TEXT NOT NULL, commune TEXT NOT NULL, booking_date TEXT NOT NULL, start_time TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pendiente', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
    const {results: existing=[]} = await env.DB.prepare("SELECT start_time,service,notes FROM service_bookings WHERE booking_date=? AND status IN ('pendiente','confirmada')").bind(date).all();
    if (existing.length >= 2) return json({error:"Ese día ya alcanzó el máximo de solicitudes/servicios. Escríbenos para revisar otra fecha."},409);
    const overlaps = existing.some(item => {
      const [eh,em] = String(item.start_time).split(":").map(Number);
      const priorDuration = requestedDuration(item.service, item.notes || "") || 120;
      const a=eh*60+em, z=a+priorDuration;
      return startMinutes < z && endMinutes > a;
    });
    if (overlaps) return json({error:"Ese horario se cruza con otro servicio solicitado. Elige otra hora."},409);
    const now = Date.now();
    const result = await env.DB.prepare("INSERT INTO service_bookings(name,phone,service,commune,booking_date,start_time,notes,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pendiente',?,?)").bind(name,phone,service,commune,date,start,notes,now,now).run();
    return json({ ok: true, id: result.meta.last_row_id, status: "pendiente", message: "Solicitud recibida. La hora queda pendiente de confirmación por EmanuelDetail." }, 201);
  }

  if (path === "promotions" && req.method === "GET") {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS promotions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price INTEGER, starts_at TEXT, ends_at TEXT, max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0, code TEXT, status TEXT NOT NULL DEFAULT 'borrador', audience TEXT NOT NULL DEFAULT 'all', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
    try { await env.DB.prepare("ALTER TABLE promotions ADD COLUMN audience TEXT NOT NULL DEFAULT 'all'").run(); } catch {}
    if (await authorized(req, env, "marketing")) {
      const { results = [] } = await env.DB.prepare("SELECT * FROM promotions ORDER BY updated_at DESC LIMIT 200").all();
      return json(results);
    }
    const today = new Date().toISOString().slice(0,10);
    const { results = [] } = await env.DB.prepare("SELECT id,title,description,price,starts_at,ends_at,max_uses,used_count,code,audience FROM promotions WHERE audience IN ('all','web') AND status='activa' AND (starts_at IS NULL OR starts_at='' OR starts_at<=?) AND (ends_at IS NULL OR ends_at='' OR ends_at>=?) AND (max_uses IS NULL OR used_count<max_uses) ORDER BY created_at DESC").bind(today,today).all();
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

  const marketingPath = path.startsWith("marketing/") || path === "bookings" || path.startsWith("bookings/") || path === "leads" || path.startsWith("leads/") || path === "promotions" || path.startsWith("promotions/");
  if (!(await authorized(req, env, marketingPath ? "marketing" : "site"))) {
    return json({ error: marketingPath ? "Debes iniciar sesión en Marketing IA." : "Debes iniciar sesión como administrador del sitio." }, 401);
  }

  // Contenido editorial centralizado: borradores y aprobaciones sincronizados entre dispositivos.
  if (path === "marketing/posts" && req.method === "GET") {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS marketing_posts (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
    const { results = [] } = await env.DB.prepare("SELECT payload FROM marketing_posts ORDER BY updated_at DESC LIMIT 500").all();
    return json(results.map(row => { try { return JSON.parse(row.payload); } catch { return null; } }).filter(Boolean));
  }
  if (path === "marketing/posts" && req.method === "POST") {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS marketing_posts (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
    let b = {}; try { b = await req.json(); } catch { return json({error:"JSON inválido."},400); }
    const id = typeof b.id === "string" ? b.id.slice(0,80) : "";
    const caption = typeof b.caption === "string" ? b.caption.trim() : "";
    const statuses = new Set(["borrador","aprobado","publicado"]);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !caption || caption.length > 5000) return json({error:"Publicación no válida: revisa el identificador y el texto (máximo 5.000 caracteres)."},400);
    if (b.status && !statuses.has(b.status)) return json({error:"Estado de publicación no válido."},400);
    const channels = Array.isArray(b.channels) ? b.channels.filter(x => typeof x === "string").slice(0,10) : [];
    const imageBase = String(env.R2_PUBLIC_URL || "").replace(/\/$/, "") + "/marketing/";
    const photo = typeof b.photo === "string" && b.photo.startsWith(imageBase) && b.photo.length <= 600 ? b.photo : "";
    const payload = {id,createdAt:typeof b.createdAt==="string"?b.createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),service:String(b.service||"Publicación").slice(0,120),commune:String(b.commune||"").slice(0,80),channels,caption,photo,status:statuses.has(b.status)?b.status:"borrador",approvedAt:typeof b.approvedAt==="string"?b.approvedAt:null};
    const now = Date.now();
    await env.DB.prepare("INSERT INTO marketing_posts(id,payload,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at").bind(id,JSON.stringify(payload),now,now).run();
    return json({ok:true,post:payload},200);
  }
  if (path.startsWith("marketing/posts/") && req.method === "DELETE") {
    const id = path.slice("marketing/posts/".length);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return json({error:"ID no válido."},400);
    await env.DB.prepare("DELETE FROM marketing_posts WHERE id=?").bind(id).run();
    return json({ok:true});
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
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS promotions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price INTEGER, starts_at TEXT, ends_at TEXT, max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0, code TEXT, status TEXT NOT NULL DEFAULT 'borrador', audience TEXT NOT NULL DEFAULT 'all', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
    try { await env.DB.prepare("ALTER TABLE promotions ADD COLUMN audience TEXT NOT NULL DEFAULT 'all'").run(); } catch {}
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
    const audience = ["all","app","web"].includes(b.audience) ? b.audience : "all";
    if (!title || (price !== null && (!Number.isSafeInteger(price) || price < 0)) || (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1))) return json({ error: "Título, precio o cupos no válidos." }, 400);
    const now = Date.now();
    const result = await env.DB.prepare("INSERT INTO promotions(title,description,price,starts_at,ends_at,max_uses,code,status,audience,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(title,description,price,String(b.starts_at||"").slice(0,10),String(b.ends_at||"").slice(0,10),maxUses,String(b.code||"").trim().slice(0,40),status,audience,now,now).run();
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
    if (!(await authorized(req, env, "site"))) return json({ error: "Debes iniciar sesión como administrador del sitio." }, 401);
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
    if (!(await authorized(req, env, "site"))) return json({ error: "Debes iniciar sesión como administrador del sitio." }, 401);
    const id = Number(path.split("/")[1]);
    await env.DB.prepare("DELETE FROM gallery WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  if (path === "products" && req.method === "POST") {
    if (!(await authorized(req, env, "site"))) return json({ error: "Debes iniciar sesión como administrador del sitio." }, 401);
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
    if (!(await authorized(req, env, "site"))) return json({ error: "Debes iniciar sesión como administrador del sitio." }, 401);
    const id = Number(path.split("/")[1]);
    await env.DB.prepare("DELETE FROM products WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  if (path === "upload" && req.method === "POST") {
    if (!(await authorized(req, env, "site"))) return json({ error: "Debes iniciar sesión como administrador del sitio." }, 401);
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
    if (!(await authorized(req, env, "marketing"))) return json({ error: "Debes iniciar sesión en Marketing IA." }, 401);
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
    if (!(await authorized(req, env, "marketing"))) return json({ error: "Debes iniciar sesión en Marketing IA." }, 401);
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
