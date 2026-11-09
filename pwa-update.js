(() => {
  'use strict';

  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  const workerUrl = new URL('./sw.js', document.currentScript?.src || location.href);
  const releaseUrl = new URL('./dlmed-version.json', workerUrl);
  let knownVersion = null;
  let knownReleaseVersion = null;
  let pendingSafeReloadVersion = null;
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

  function isOAuthCallback() {
    const query = new URLSearchParams(location.search);
    return query.has('code') || query.has('error')
      || /(?:^|[&#])(access_token|refresh_token|error|code)=/i.test(location.hash);
  }

  function reloadOnceForVersion(version) {
    if (isQuizSectionActive()) {
      deferReloadUntilQuizIsSafe(version);
      return;
    }
    const reloadKey = 'dlmed-pwa-reloaded-version';
    try {
      if (sessionStorage.getItem(reloadKey) === version) return;
      sessionStorage.setItem(reloadKey, version);
    } catch (_) {
      // Comparing the active worker version still prevents an update loop.
    }
    location.reload();
  }

  function isQuizSectionActive() {
    if (!/(?:^|\/)quiz\.html$/i.test(location.pathname)) return false;
    const pauseButton = document.getElementById('pauseTimerBtn');
    const resultOverlay = document.getElementById('sectionOverlay');
    return Boolean((pauseButton && !pauseButton.disabled) || resultOverlay?.classList.contains('show'));
  }

  function deferReloadUntilQuizIsSafe(version) {
    pendingSafeReloadVersion = version;
    const check = () => {
      if (pendingSafeReloadVersion !== version) return;
      if (isQuizSectionActive()) {
        window.setTimeout(check, 1000);
        return;
      }
      pendingSafeReloadVersion = null;
      reloadOnceForVersion(version);
    };
    window.setTimeout(check, 1000);
  }

  function reloadAfterOAuthCallback(version) {
    const authReady = window.DLMED_AUTH?.authReady;
    if (!authReady || typeof authReady.then !== 'function') return;
    Promise.resolve(authReady).catch(() => {}).then(() => {
      let attempts = 0;
      const waitForCallback = () => {
        if (!isOAuthCallback()) {
          reloadOnceForVersion(version);
        } else if (++attempts < 60) {
          window.setTimeout(waitForCallback, 500);
        }
      };
      waitForCallback();
    });
  }

  async function readReleaseVersion() {
    const url = new URL(releaseUrl.href);
    url.searchParams.set('_check', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const response = await fetch(url.href, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return null;
    const release = await response.json();
    return typeof release.version === 'string' ? release.version : null;
  }

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
    if (window.DLMED_CACHE_CLEAN_RUNNING) {
      window.DLMED_CACHE_CLEAN_PENDING_VERSION = nextVersion;
      return;
    }
    if (isOAuthCallback()) {
      reloadAfterOAuthCallback(nextVersion);
      return;
    }
    reloadOnceForVersion(nextVersion);
  });

  let registration = null;
  let updateTimer = 0;

  async function checkForUpdate() {
    if (!registration || document.visibilityState !== 'visible' || !navigator.onLine) return;
    try {
      const releaseVersion = await readReleaseVersion();
      if (releaseVersion && releaseVersion !== knownReleaseVersion) {
        knownReleaseVersion = releaseVersion;
        const activeVersion = await readVersion(navigator.serviceWorker.controller);
        if (activeVersion && activeVersion !== releaseVersion) {
          try { await registration.update(); } catch (_) {}
          return;
        }
      }
    } catch (_) {
      // The worker update check still runs if the release marker is unavailable.
    }
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
