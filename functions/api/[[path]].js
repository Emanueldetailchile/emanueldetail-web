const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const cors = (r) => r;
function authorized(req, env) { const h=req.headers.get('Authorization')||''; return !!env.ADMIN_TOKEN && h === `Bearer ${env.ADMIN_TOKEN}`; }
export async function onRequest(context) {
 const {request:req, env}=context; const url=new URL(req.url); const path=url.pathname.replace(/^\/api\/?/,'');
 if(path==='health' && req.method==='GET') return json({ok:true,db:!!env.DB,images:!!env.IMAGES,adminConfigured:!!env.ADMIN_TOKEN});
 if(path==='login' && req.method==='POST') { let b={}; try{b=await req.json()}catch{}; if(!env.ADMIN_TOKEN) return json({error:'Falta configurar ADMIN_TOKEN en Pages > Settings > Variables and Secrets'},503); return b.token===env.ADMIN_TOKEN?json({ok:true}):json({error:'Clave incorrecta'},401); }
 if(!env.DB) return json({error:'No está vinculada la base D1 (binding DB)'},503);
 if(path==='gallery' && req.method==='GET') { const {results=[]}=await env.DB.prepare('SELECT id,image_url,caption,created_at FROM gallery ORDER BY id DESC').all(); return json(results); }
 if(path==='products' && req.method==='GET') { const {results=[]}=await env.DB.prepare('SELECT id,name,price,category,description,image_url,payment_url,active,created_at FROM products WHERE active=1 ORDER BY id DESC').all(); return json(results); }
 if(!authorized(req,env)) return json({error:'Debes iniciar sesión como administrador'},401);
 if(path==='gallery' && req.method==='POST') { const b=await req.json(); if(!b.image_url) return json({error:'Falta la URL de la imagen'},400); const r=await env.DB.prepare('INSERT INTO gallery(image_url,caption,created_at) VALUES(?,?,?)').bind(b.image_url,b.caption||'',Date.now()).run(); return json({ok:true,id:r.meta.last_row_id},201); }
 if(path.startsWith('gallery/') && req.method==='DELETE') { const id=Number(path.split('/')[1]); await env.DB.prepare('DELETE FROM gallery WHERE id=?').bind(id).run(); return json({ok:true}); }
 if(path==='products' && req.method==='POST') { const b=await req.json(); if(!b.name) return json({error:'Falta el nombre del producto'},400); const r=await env.DB.prepare('INSERT INTO products(name,price,category,description,image_url,payment_url,active,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(b.name,b.price||'',b.category||'',b.description||'',b.image_url||'',b.payment_url||'',b.active===false?0:1,Date.now()).run(); return json({ok:true,id:r.meta.last_row_id},201); }
 if(path.startsWith('products/') && req.method==='DELETE') { const id=Number(path.split('/')[1]); await env.DB.prepare('DELETE FROM products WHERE id=?').bind(id).run(); return json({ok:true}); }
 if(path==='upload' && req.method==='POST') { if(!env.IMAGES) return json({error:'Falta vincular R2 con el binding IMAGES'},503); const form=await req.formData(); const file=form.get('file'); if(!file || typeof file==='string') return json({error:'Selecciona una imagen'},400); if(!file.type.startsWith('image/')) return json({error:'Solo se permiten imágenes'},400); if(file.size>8*1024*1024) return json({error:'Máximo 8 MB por imagen'},413); const ext=(file.name.split('.').pop()||'jpg').replace(/[^a-z0-9]/gi,'').toLowerCase()||'jpg'; const key=`uploads/${crypto.randomUUID()}.${ext}`; await env.IMAGES.put(key,file.stream(),{httpMetadata:{contentType:file.type}}); return json({ok:true,key,publicUrl:env.R2_PUBLIC_URL?`${env.R2_PUBLIC_URL.replace(/\/$/,'')}/${key}`:null},201); }
 return json({error:'Ruta no encontrada'},404);
}
