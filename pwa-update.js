(() => {
  'use strict';

  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  const workerUrl = new URL('./sw.js', document.currentScript?.src || location.href);
  let knownVersion = null;
  const startingController = navigator.serviceWorker.controller;

  function readVersion(worker) {
    if (!worker || typeof MessageChannel === 'undefined') return Promise.resolve(null);
    return new Promise(resolve => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => {
        channel.port1.close();
        resolve(null);
      }, 1500);
      channel.port1.onmessage = event => {
        window.clearTimeout(timeout);
        channel.port1.close();
        resolve(event.data?.version || null);
      };
      try {
        worker.postMessage({ type: 'DLMED_GET_SW_VERSION' }, [channel.port2]);
      } catch (_) {
        window.clearTimeout(timeout);
        channel.port1.close();
        resolve(null);
      }
    });
  }

  const initialVersionReady = startingController
    ? readVersion(startingController).then(version => { knownVersion = version; })
    : Promise.resolve();

  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'DLMED_UPDATE_ACTIVATED') {
      event.ports?.[0]?.postMessage({ handled: true });
    }
  });

  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    await initialVersionReady;
    const controller = navigator.serviceWorker.controller;
    if (!controller) return;
    const nextVersion = await readVersion(controller);
    if (!nextVersion) return;
    const previousVersion = knownVersion;
    knownVersion = nextVersion;
    if (previousVersion === nextVersion) return;
    if (!previousVersion && !startingController) return;

    const reloadKey = 'dlmed-pwa-reloaded-version';
    try {
      if (sessionStorage.getItem(reloadKey) === nextVersion) return;
      sessionStorage.setItem(reloadKey, nextVersion);
    } catch (_) {
      // The version comparison still prevents repeat reloads when storage is unavailable.
    }
    location.reload();
  });

  let registration = null;
  let updateTimer = 0;

  async function checkForUpdate() {
    if (!registration || document.visibilityState !== 'visible' || !navigator.onLine) return;
    try { await registration.update(); } catch (_) {}
  }

  function startUpdatePolling() {
    if (registration && !updateTimer) {
      updateTimer = window.setInterval(checkForUpdate, 5 * 60 * 1000);
    }
  }

  navigator.serviceWorker.register(workerUrl.href, { updateViaCache: 'none' })
    .then(value => {
      registration = value;
      void checkForUpdate();
      startUpdatePolling();
      window.addEventListener('focus', checkForUpdate);
      window.addEventListener('online', checkForUpdate);
      document.addEventListener('visibilitychange', checkForUpdate);
      window.addEventListener('pageshow', () => {
        startUpdatePolling();
        void checkForUpdate();
      });

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && registration.waiting) {
            registration.waiting.postMessage({ type: 'DLMED_SKIP_WAITING' });
          }
        });
      });

      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'DLMED_SKIP_WAITING' });
      }
    })
    .catch(() => {});

  window.addEventListener('pagehide', () => {
    if (updateTimer) window.clearInterval(updateTimer);
    updateTimer = 0;
  });
})();
