(() => {
  const render = () => {
    const app = document.getElementById('app');
    if (!app || app.classList.contains('hidden') || document.getElementById('ed-admin-visits')) return;
    const card = document.createElement('section');
    card.className = 'card'; card.id = 'ed-admin-visits';
    card.innerHTML = '<h2>Estadísticas de visitas</h2><p class="small">Cifras reales registradas; sin base promocional.</p><div class="grid"><div><strong>Visitantes únicos</strong><p id="ed-admin-unique">Cargando…</p></div><div><strong>Visitas totales</strong><p id="ed-admin-total">Cargando…</p></div></div><p class="small">Visitante único: navegador identificado mediante cookie persistente. Visita total: una por sesión de navegador; recargar la página no suma otra visita.</p>';
    const images = document.getElementById('site-images-card');
    if (images) images.insertAdjacentElement('afterend', card); else app.prepend(card);
    fetch('/api/visits',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error();return r.json()}).then(s=>{
      document.getElementById('ed-admin-unique').textContent=Number(s.uniqueVisitors).toLocaleString('es-CL');
      document.getElementById('ed-admin-total').textContent=Number(s.totalVisits).toLocaleString('es-CL');
    }).catch(()=>{document.getElementById('ed-admin-unique').textContent='No disponible';document.getElementById('ed-admin-total').textContent='No disponible'});
  };
  new MutationObserver(render).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']}); render();
})();