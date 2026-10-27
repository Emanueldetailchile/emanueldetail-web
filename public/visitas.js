// Contador público EmanuelDetail.
(() => {
  const style = document.createElement('style');
  style.textContent = '#ed-visit-counter{position:fixed;left:12px;bottom:12px;z-index:19;background:#090909ed;border:1px solid #8e6b1e;border-radius:12px;padding:8px 11px;color:#f8f6ef;font:11px/1.45 Arial,sans-serif;box-shadow:0 2px 12px #0008;max-width:190px}#ed-visit-counter strong{color:#f6c644}@media(max-width:600px){#ed-visit-counter{bottom:64px;left:8px;padding:6px 8px;font-size:10px;max-width:160px}}';
  document.head.appendChild(style);
  const el = document.createElement('aside'); el.id = 'ed-visit-counter'; el.setAttribute('aria-label','Comunidad Detail');
  el.innerHTML = '<strong>Comunidad Detail</strong><div>Visitantes: <span id="ed-unique">—</span></div>';
  document.body.appendChild(el);
  (async () => { try { await fetch('/api/visits',{method:'POST',credentials:'same-origin',cache:'no-store'}); const r=await fetch('/api/visits',{cache:'no-store'}); if(!r.ok) throw new Error('stats'); const s=await r.json(); document.getElementById('ed-unique').textContent=String(s.uniqueVisitors+5); } catch (_) { el.hidden=true; } })();
})();