(() => {
  const online = document.getElementById('visitorOnline');
  const status = document.getElementById('visitorStatus');
  const badge = document.getElementById('visitorCounter');
  const endpoint = String(window.DLMED_VISITOR_COUNTER_URL || '').trim();
  const numberFormat = new Intl.NumberFormat('fr-FR');
  if (!online || !status || !badge) return;

  if (!endpoint) {
    online.textContent = '—';
    status.textContent = 'Compteur à connecter';
    badge.title = 'Compteur en attente de connexion';
    return;
  }

  badge.title = 'Connexions uniques par adresse IP actives durant les 90 dernières secondes';
  let activeRequest = false;
  async function refreshOnlineCount() {
    if (activeRequest || document.hidden || !navigator.onLine) {
      if (!navigator.onLine) {
        online.textContent = '—';
        status.textContent = 'Compteur indisponible hors ligne';
      }
      return;
    }
    activeRequest = true;
    try {
      const response = await fetch(endpoint, { method: 'POST', mode: 'cors', cache: 'no-store' });
      if (!response.ok) throw new Error('Counter service unavailable');
      const data = await response.json();
      if (!Number.isFinite(data.online)) throw new Error('Invalid counter response');
      online.textContent = numberFormat.format(data.online);
      status.textContent = 'Compteur en direct';
    } catch (_) {
      online.textContent = '—';
      status.textContent = 'Compteur momentanément indisponible';
    } finally {
      activeRequest = false;
    }
  }

  refreshOnlineCount();
  window.setInterval(refreshOnlineCount, 30000);
  window.addEventListener('online', refreshOnlineCount);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshOnlineCount();
  });
})();