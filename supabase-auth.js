(() => {
  'use strict';

  const client = window.DLMED_SUPABASE;
  const DEVICE_KEY = 'dlmed-device-id-v1';
  const INTENT_KEY = 'dlmed-auth-intent-v1';
  const OAUTH_PENDING_KEY = 'dlmed-oauth-pending-v1';
  const OAUTH_PREVIOUS_SESSION_KEY = 'dlmed-oauth-previous-session-v1';
  const INVALID_SESSION_MESSAGE = 'Votre compte a été connecté sur un autre appareil. Votre session a été fermée.';
  const CACHE_KEY = 'dlmed-supabase-cache-v1';
  const pageIsQuiz = document.body.dataset.page === 'quiz';

  let state = 'booting';
  let activeSession = null;
  let activeUser = null;
  let activeUsername = '';
  let heartbeatTimer = null;
  let heartbeatPromise = null;
  let establishPromise = null;
  let establishSessionId = '';
  let signingOut = false;
  let mandatoryGate = pageIsQuiz;
  let focusBeforeDialog = null;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  try { localStorage.removeItem(CACHE_KEY); } catch (_) {}

  function newUuid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    if (!window.crypto?.getRandomValues) throw new Error('UUID_UNAVAILABLE');
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function deviceId() {
    try {
      const stored = localStorage.getItem(DEVICE_KEY);
      if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored)) return stored;
      const created = newUuid();
      localStorage.setItem(DEVICE_KEY, created);
      return created;
    } catch (_) {
      return newUuid();
    }
  }

  const localDeviceId = deviceId();

  function mountGate() {
    if (document.getElementById('dlmedAuthGate')) return;
    const style = document.createElement('style');
    style.id = 'dlmedAuthStyles';
    style.textContent = `
      .dlmed-auth-backdrop{position:fixed;inset:0;z-index:10050;display:grid;place-items:center;padding:18px;background:rgba(12,25,43,.62);backdrop-filter:blur(8px);opacity:1;transition:opacity .22s ease}
      .dlmed-auth-backdrop[hidden]{display:none}
      .dlmed-auth-close[hidden],#dlmedLoginPanel[hidden],#dlmedUsernamePanel[hidden],#dlmedSignOut[hidden],#dlmedAuthUsername[hidden],.dlmed-account-pill[hidden]{display:none!important}
      .dlmed-auth-card{position:relative;width:min(100%,440px);padding:28px;border:1px solid var(--line,#e7edf4);border-radius:24px;background:var(--paper,#fff);color:var(--ink,#17283f);box-shadow:0 26px 90px rgba(7,19,37,.3);animation:dlmedAuthIn .24s cubic-bezier(.2,.8,.2,1) both}
      @keyframes dlmedAuthIn{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}
      .dlmed-auth-close{position:absolute;top:13px;right:13px;width:36px;height:36px;border:1px solid var(--line,#e7edf4);border-radius:12px;background:transparent;color:var(--muted,#718096);font-size:20px}
      .dlmed-auth-brand{display:flex;align-items:center;gap:11px;margin-bottom:23px;font:800 17px Manrope,sans-serif;letter-spacing:-.4px}
      .dlmed-auth-mark{display:grid;place-items:center;width:40px;height:40px;border-radius:14px;background:linear-gradient(145deg,#477ff0,#2d61d2);color:white;font-size:20px;box-shadow:0 8px 18px #326de633}
      .dlmed-auth-eyebrow{margin:0 0 7px;color:var(--blue,#326de6);font-size:10px;font-weight:800;letter-spacing:1.3px;text-transform:uppercase}
      .dlmed-auth-card h2{margin:0 0 9px;font:800 23px/1.25 Manrope,sans-serif;letter-spacing:-.7px}
      .dlmed-auth-copy{margin:0 0 21px;color:var(--muted,#718096);font-size:13px;line-height:1.6}
      .dlmed-auth-message{margin:0 0 15px;padding:11px 12px;border:1px solid #f1c7cc;border-radius:12px;background:#fff4f4;color:#a23e4a;font-size:12px;line-height:1.5}
      :root[data-theme="night"] .dlmed-auth-message{border-color:#6e3d49;background:#39242d;color:#ffc0c7}
      .dlmed-google-button{width:100%;min-height:48px;display:flex;align-items:center;justify-content:center;gap:11px;border:1px solid var(--line,#e7edf4);border-radius:13px;background:var(--paper,#fff);color:var(--ink,#17283f);font-size:14px;font-weight:700;transition:transform .18s,border-color .18s,box-shadow .18s}
      .dlmed-google-button:hover{transform:translateY(-1px);border-color:#a9bfe9;box-shadow:0 8px 20px #20365412}
      .dlmed-google-g{display:grid;place-items:center;width:23px;height:23px;border:1px solid var(--line,#e7edf4);border-radius:50%;background:#fff;color:#4285f4;font:800 15px Arial,sans-serif}
      .dlmed-auth-note{margin:13px 0 0;color:var(--muted,#718096);font-size:11px;line-height:1.5;text-align:center}
      .dlmed-auth-field{width:100%;height:47px;margin:0 0 9px;padding:0 13px;border:1px solid var(--line,#e7edf4);border-radius:12px;background:var(--paper,#fff);color:var(--ink,#17283f);outline:none}
      .dlmed-auth-field:focus{border-color:#7fa4f1;box-shadow:0 0 0 3px #326de61a}
      .dlmed-auth-help{margin:0 0 12px;color:var(--muted,#718096);font-size:11px;line-height:1.45}
      .dlmed-auth-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}
      .dlmed-auth-status{min-height:19px;margin:4px 0 10px;color:var(--muted,#718096);font-size:12px}
      .dlmed-auth-status[data-tone="error"]{color:#bf4654}
      .dlmed-auth-status[data-tone="success"]{color:#168266}
      .dlmed-auth-spinner{display:inline-block;width:15px;height:15px;margin-right:8px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;vertical-align:-3px;animation:dlmedAuthSpin .7s linear infinite}
      @keyframes dlmedAuthSpin{to{transform:rotate(360deg)}}
      .dlmed-account-pill{display:inline-flex;align-items:center;gap:7px;margin-top:8px;color:var(--muted,#718096);font-size:11px}
      .dlmed-account-pill strong{color:var(--ink,#17283f);font-size:12px}
      .dlmed-account-logout{padding:2px 4px;border:0;background:transparent;color:var(--blue,#326de6);font-size:11px;font-weight:700}
      .dlmed-username-logout{display:block;margin:3px auto 0;padding:7px;border:0;background:transparent;color:var(--muted,#718096);font-size:11px;font-weight:700}
      #dlmedSignOut{width:38px;height:38px;padding:0;display:inline-grid;place-items:center;font-size:17px}
      #dlmedAuthUsername{max-width:135px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;align-self:center;color:var(--muted,#718096);font-size:11px}
      @media(max-width:700px){.dlmed-auth-card{padding:23px 19px;border-radius:20px}.dlmed-auth-card h2{font-size:21px}#dlmedAuthUsername{display:none}}
      @media(prefers-reduced-motion:reduce){.dlmed-auth-backdrop,.dlmed-auth-card{animation:none;transition:none}}
    `;
    document.head.append(style);

    const gate = document.createElement('div');
    gate.id = 'dlmedAuthGate';
    gate.className = 'dlmed-auth-backdrop';
    gate.hidden = true;
    gate.innerHTML = `
      <section class="dlmed-auth-card" role="dialog" aria-modal="true" aria-labelledby="dlmedAuthTitle">
        <button class="dlmed-auth-close" id="dlmedAuthClose" type="button" aria-label="Fermer">×</button>
        <div class="dlmed-auth-brand"><span class="dlmed-auth-mark" aria-hidden="true">✚</span><span>DLMED</span></div>
        <div id="dlmedLoginPanel">
          <p class="dlmed-auth-eyebrow">Espace étudiant</p>
          <h2 id="dlmedAuthTitle">Connecte-toi pour réviser</h2>
          <p class="dlmed-auth-copy">Utilise ton compte Google pour accéder aux modules et retrouver ta session.</p>
          <p class="dlmed-auth-message" id="dlmedAuthMessage" role="status" hidden></p>
          <button class="dlmed-google-button" id="dlmedGoogleLogin" type="button"><span class="dlmed-google-g" aria-hidden="true">G</span><span>Continue with Google</span></button>
          <p class="dlmed-auth-note">Ta session active est limitée à un seul appareil.</p>
        </div>
        <div id="dlmedUsernamePanel" hidden>
          <p class="dlmed-auth-eyebrow">Première connexion</p>
          <h2 id="dlmedUsernameTitle">Choisis ton username</h2>
          <p class="dlmed-auth-copy">Ce nom sera associé à ton compte et ne sera plus demandé après son enregistrement.</p>
          <form id="dlmedUsernameForm" novalidate>
            <label class="dlmed-auth-help" for="dlmedUsernameInput">4–20 caractères : lettres anglaises, chiffres ou underscore.</label>
            <input class="dlmed-auth-field" id="dlmedUsernameInput" name="username" type="text" minlength="4" maxlength="20" pattern="[A-Za-z0-9_]{4,20}" autocomplete="username" autocapitalize="off" spellcheck="false" required>
            <div class="dlmed-auth-status" id="dlmedUsernameStatus" aria-live="polite"></div>
            <div class="dlmed-auth-actions"><button class="btn" id="dlmedCheckUsername" type="button">Vérifier</button><button class="btn primary" id="dlmedSaveUsername" type="submit">Continuer</button></div>
          </form>
          <button class="dlmed-username-logout" id="dlmedUsernameLogout" type="button">Se déconnecter et changer de compte</button>
        </div>
      </section>`;
    document.body.append(gate);
    gate.addEventListener('click', event => { if (event.target === gate && !mandatoryGate) hideGate(); });
    gate.querySelector('#dlmedAuthClose').addEventListener('click', hideGate);
    gate.querySelector('#dlmedGoogleLogin').addEventListener('click', beginGoogleLogin);
    gate.querySelector('#dlmedCheckUsername').addEventListener('click', checkUsername);
    gate.querySelector('#dlmedUsernameLogout').addEventListener('click', logout);
    gate.querySelector('#dlmedUsernameForm').addEventListener('submit', saveUsername);
    gate.querySelector('#dlmedUsernameInput').addEventListener('input', () => {
      setUsernameStatus('', '');
      gate.querySelector('#dlmedSaveUsername').disabled = false;
    });
    addAccountControls();
  }

  function addAccountControls() {
    const topActions = document.querySelector('.top-actions');
    if (topActions && !document.getElementById('dlmedSignOut')) {
      const name = document.createElement('span');
      name.id = 'dlmedAuthUsername';
      name.hidden = true;
      const button = document.createElement('button');
      button.id = 'dlmedSignOut';
      button.className = 'btn ghost';
      button.type = 'button';
      button.title = 'Se déconnecter';
      button.setAttribute('aria-label', 'Se déconnecter');
      button.textContent = '↪';
      button.hidden = true;
      button.addEventListener('click', logout);
      topActions.prepend(button);
      topActions.prepend(name);
    }
    const welcomeContact = document.querySelector('.welcome-contact');
    if (welcomeContact && !document.getElementById('dlmedWelcomeAccount')) {
      const account = document.createElement('span');
      account.id = 'dlmedWelcomeAccount';
      account.className = 'dlmed-account-pill';
      account.hidden = true;
      account.innerHTML = '<strong id="dlmedWelcomeUsername"></strong><button class="dlmed-account-logout" type="button">Se déconnecter</button>';
      account.querySelector('button').addEventListener('click', logout);
      welcomeContact.append(account);
    }
  }

  function updateAccountControls() {
    const signedIn = state === 'active';
    const topName = document.getElementById('dlmedAuthUsername');
    const topButton = document.getElementById('dlmedSignOut');
    const welcome = document.getElementById('dlmedWelcomeAccount');
    if (topName) { topName.hidden = !signedIn; topName.textContent = activeUsername || ''; }
    if (topButton) topButton.hidden = !signedIn;
    if (welcome) {
      welcome.hidden = !signedIn;
      const userName = document.getElementById('dlmedWelcomeUsername');
      if (userName) userName.textContent = activeUsername || '';
    }
  }

  function setStatus(next) {
    state = next;
    updateAccountControls();
    if (['active', 'username_required', 'anonymous', 'locked'].includes(next)) resolveReady(next);
  }

  function showGate({ message = '', mandatory = false, username = false } = {}) {
    mountGate();
    mandatoryGate = Boolean(mandatory);
    const gate = document.getElementById('dlmedAuthGate');
    const close = document.getElementById('dlmedAuthClose');
    const loginPanel = document.getElementById('dlmedLoginPanel');
    const usernamePanel = document.getElementById('dlmedUsernamePanel');
    const messageNode = document.getElementById('dlmedAuthMessage');
    focusBeforeDialog = document.activeElement;
    gate.hidden = false;
    gate.setAttribute('aria-hidden', 'false');
    close.hidden = mandatoryGate || username;
    loginPanel.hidden = username;
    usernamePanel.hidden = !username;
    messageNode.hidden = !message;
    messageNode.textContent = message;
    if (username) setTimeout(() => document.getElementById('dlmedUsernameInput')?.focus(), 30);
    else setTimeout(() => document.getElementById('dlmedGoogleLogin')?.focus(), 30);
  }

  function hideGate() {
    const gate = document.getElementById('dlmedAuthGate');
    if (!gate || mandatoryGate || state === 'username_required') return;
    gate.hidden = true;
    gate.setAttribute('aria-hidden', 'true');
    if (focusBeforeDialog?.focus) focusBeforeDialog.focus();
  }

  function frenchError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (message.includes('access_denied') || message.includes('cancel')) return 'La connexion Google a été annulée. Tu peux réessayer.';
    if (error?.code === 'P0001' || message.includes('too many username availability checks')) return 'Trop de vérifications en peu de temps. Attends une minute puis réessaie.';
    if (message.includes('network') || message.includes('fetch')) return 'Connexion au serveur impossible. Vérifie Internet et réessaie.';
    if (message.includes('provider') || message.includes('google')) return 'La connexion Google n’est pas encore configurée. Réessaie plus tard.';
    if (message.includes('username') || message.includes('invalid')) return 'Username invalide. Utilise 4 à 20 lettres anglaises, chiffres ou underscore.';
    return 'Une erreur est survenue. Réessaie dans un instant.';
  }

  function showLoginMessage(message) {
    const node = document.getElementById('dlmedAuthMessage');
    if (!node) return;
    node.textContent = message;
    node.hidden = !message;
  }

  function getIntent() {
    try { return sessionStorage.getItem(INTENT_KEY) || ''; } catch (_) { return ''; }
  }

  function setIntent(intent) {
    try { sessionStorage.setItem(INTENT_KEY, intent); } catch (_) {}
  }

  function resumeIntent() {
    const intent = getIntent();
    try { sessionStorage.removeItem(INTENT_KEY); } catch (_) {}
    if (intent === 'open-picker') setTimeout(() => document.getElementById('openModulePicker')?.click(), 0);
  }

  function decodeSessionId(accessToken) {
    try {
      const part = accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
      return typeof payload.session_id === 'string' ? payload.session_id : '';
    } catch (_) { return ''; }
  }

  function mayClaimOAuthSession(sessionId) {
    try {
      return Boolean(window.DLMED_OAUTH_CALLBACK
        && sessionStorage.getItem(OAUTH_PENDING_KEY) === '1'
        && sessionId
        && sessionId !== (sessionStorage.getItem(OAUTH_PREVIOUS_SESSION_KEY) || ''));
    } catch (_) { return false; }
  }

  function clearOAuthPending() {
    try {
      sessionStorage.removeItem(OAUTH_PENDING_KEY);
      sessionStorage.removeItem(OAUTH_PREVIOUS_SESSION_KEY);
    } catch (_) {}
  }

  async function isSessionRevokedError(error) {
    const message = String(error?.message || '').toLowerCase();
    return error?.code === '42501' || error?.code === 'SESSION_INACTIVE' || error?.code === 'SESSION_REVOKED' || message.includes('session is no longer valid') || message.includes('active authenticated session') || message.includes('no longer the active dlmed session');
  }

  async function establish(session) {
    if (!client || !session?.user || !session?.access_token) throw new Error('AUTH_UNAVAILABLE');
    const tokenSessionId = decodeSessionId(session.access_token);
    if (!tokenSessionId) throw new Error('SESSION_ID_MISSING');
    if (state === 'active' && activeSession?.session_id === tokenSessionId) return 'active';
    if (establishPromise && establishSessionId === tokenSessionId) return establishPromise;
    establishSessionId = tokenSessionId;
    setStatus('checking');
    establishPromise = (async () => {
      const { data: alreadyActive, error: heartbeatError } = await client.rpc('dlmed_active_session_heartbeat');
      if (heartbeatError) throw heartbeatError;
      if (alreadyActive !== true) {
        if (!mayClaimOAuthSession(tokenSessionId)) {
          const inactiveError = new Error('The saved session is no longer the active DLMed session.');
          inactiveError.code = 'SESSION_INACTIVE';
          throw inactiveError;
        }
        const { error: claimError } = await client.rpc('dlmed_claim_active_session', { p_device_id: localDeviceId });
        if (claimError) throw claimError;
        clearOAuthPending();
      }

      const { data: profile, error: profileError } = await client.from('profiles')
        .select('username').eq('user_id', session.user.id).maybeSingle();
      if (profileError) throw profileError;
      if (alreadyActive === true && window.DLMED_OAUTH_CALLBACK) clearOAuthPending();
      const { data: stillActive, error: verifyError } = await client.rpc('dlmed_active_session_heartbeat');
      if (verifyError) throw verifyError;
      if (stillActive !== true) {
        const inactiveError = new Error('The saved session is no longer the active DLMed session.');
        inactiveError.code = 'SESSION_INACTIVE';
        throw inactiveError;
      }

      activeSession = { session_id: tokenSessionId, device_id: localDeviceId };
      activeUser = session.user;
      activeUsername = profile?.username || '';
      if (!activeUsername) {
        setStatus('username_required');
        showGate({ username: true, mandatory: true });
        startHeartbeat();
        return 'username_required';
      }

      setStatus('active');
      hideGateAfterAuthentication();
      dispatchAuthorized();
      startHeartbeat();
      if (window.DLMED_UI?.initialize) await window.DLMED_UI.initialize();
      resumeIntent();
      return 'active';
    })();
    try { return await establishPromise; }
    finally { establishPromise = null; establishSessionId = ''; }
  }

  function hideGateAfterAuthentication() {
    mandatoryGate = false;
    const gate = document.getElementById('dlmedAuthGate');
    if (gate) { gate.hidden = true; gate.setAttribute('aria-hidden', 'true'); }
  }

  function dispatchAuthorized() {
    window.dispatchEvent(new CustomEvent('dlmed:auth-authorized', { detail: { userId: activeUser?.id, username: activeUsername } }));
  }

  function lockApp(message) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    activeSession = null;
    activeUser = null;
    activeUsername = '';
    setStatus('locked');
    try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
    window.dispatchEvent(new CustomEvent('dlmed:auth-locked', { detail: { message } }));
    showGate({ message, mandatory: true });
  }

  async function forceLocalSignOut(message) {
    lockApp(message || INVALID_SESSION_MESSAGE);
    if (!client) return;
    signingOut = true;
    try { await client.auth.signOut({ scope: 'local' }); } catch (_) {}
    signingOut = false;
  }

  async function checkActiveSession() {
    if (!['active', 'username_required'].includes(state) || !activeSession) return false;
    if (heartbeatPromise) return heartbeatPromise;
    heartbeatPromise = (async () => {
      try {
        const { data, error } = await client.rpc('dlmed_active_session_heartbeat');
        if (error) {
          if (await isSessionRevokedError(error)) await forceLocalSignOut(INVALID_SESSION_MESSAGE);
          else await forceLocalSignOut('Impossible de vérifier la session. Reconnecte-toi pour continuer.');
          return false;
        }
        if (data !== true) {
          await forceLocalSignOut(INVALID_SESSION_MESSAGE);
          return false;
        }
        return true;
      } catch (_) {
        await forceLocalSignOut('Impossible de vérifier la session. Reconnecte-toi pour continuer.');
        return false;
      }
    })();
    try { return await heartbeatPromise; }
    finally { heartbeatPromise = null; }
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => { void checkActiveSession(); }, 12000);
  }

  async function beginGoogleLogin() {
    const button = document.getElementById('dlmedGoogleLogin');
    if (!client) { showLoginMessage('Le service d’authentification est indisponible. Recharge la page.'); return; }
    if (button) { button.disabled = true; button.innerHTML = '<span class="dlmed-auth-spinner" aria-hidden="true"></span><span>Connexion à Google…</span>'; }
    const intent = pageIsQuiz ? 'quiz' : 'open-picker';
    setIntent(intent);
    try {
      const { data: currentSession } = await client.auth.getSession();
      const previousSessionId = currentSession?.session?.access_token
        ? decodeSessionId(currentSession.session.access_token)
        : '';
      sessionStorage.setItem(OAUTH_PENDING_KEY, '1');
      sessionStorage.setItem(OAUTH_PREVIOUS_SESSION_KEY, previousSessionId);
      const redirectTo = new URL(window.location.pathname, window.location.origin).toString();
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          queryParams: { prompt: 'select_account' }
        }
      });
      if (error) throw error;
    } catch (error) {
      clearOAuthPending();
      if (button) { button.disabled = false; button.innerHTML = '<span class="dlmed-google-g" aria-hidden="true">G</span><span>Continue with Google</span>'; }
      showLoginMessage(frenchError(error));
    }
  }

  function validUsername(value) { return /^[A-Za-z0-9_]{4,20}$/.test(value); }

  function setUsernameStatus(message, tone) {
    const node = document.getElementById('dlmedUsernameStatus');
    if (!node) return;
    node.textContent = message;
    node.dataset.tone = tone || '';
  }

  async function checkUsername() {
    const input = document.getElementById('dlmedUsernameInput');
    const value = input?.value || '';
    if (!validUsername(value)) { setUsernameStatus('Entre 4 à 20 lettres anglaises, chiffres ou underscore.', 'error'); return false; }
    const button = document.getElementById('dlmedCheckUsername');
    if (button) { button.disabled = true; button.textContent = 'Vérification…'; }
    try {
      const valid = await window.DLMED_AUTH.ensureActiveSession();
      if (!valid) return false;
      const { data, error } = await client.rpc('dlmed_username_is_available', { p_username: value });
      if (error) throw error;
      const available = data === true;
      setUsernameStatus(available ? 'Username disponible.' : 'Ce username est déjà utilisé.', available ? 'success' : 'error');
      return available;
    } catch (error) {
      setUsernameStatus(frenchError(error), 'error');
      return false;
    } finally {
      if (button) { button.disabled = false; button.textContent = 'Vérifier'; }
    }
  }

  async function saveUsername(event) {
    event.preventDefault();
    const input = document.getElementById('dlmedUsernameInput');
    const value = input?.value || '';
    if (!validUsername(value)) { setUsernameStatus('Username invalide. Utilise 4 à 20 lettres anglaises, chiffres ou underscore.', 'error'); input?.focus(); return; }
    const button = document.getElementById('dlmedSaveUsername');
    if (button) { button.disabled = true; button.innerHTML = '<span class="dlmed-auth-spinner" aria-hidden="true"></span>Enregistrement…'; }
    try {
      if (!await window.DLMED_AUTH.ensureActiveSession()) throw new Error('SESSION_REVOKED');
      const available = await client.rpc('dlmed_username_is_available', { p_username: value });
      if (available.error) throw available.error;
      if (available.data !== true) {
        setUsernameStatus('Ce username est déjà utilisé. Essaie-en un autre.', 'error');
        return;
      }
      const { data, error } = await client.rpc('dlmed_set_username', { p_username: value });
      if (error) throw error;
      if (!data?.ok) {
        setUsernameStatus(data?.status === 'taken' ? 'Ce username vient d’être pris. Choisis-en un autre.' : 'Username invalide.', 'error');
        return;
      }
      if (!await window.DLMED_AUTH.ensureActiveSession()) throw new Error('SESSION_REVOKED');
      activeUsername = data.username || value;
      setStatus('active');
      hideGateAfterAuthentication();
      dispatchAuthorized();
      startHeartbeat();
      if (window.DLMED_UI?.initialize) await window.DLMED_UI.initialize();
      resumeIntent();
    } catch (error) {
      if (await isSessionRevokedError(error)) await forceLocalSignOut(INVALID_SESSION_MESSAGE);
      else setUsernameStatus(frenchError(error), 'error');
    } finally {
      if (button && state === 'username_required') { button.disabled = false; button.textContent = 'Continuer'; }
    }
  }

  async function logout() {
    if (!client || signingOut) return;
    signingOut = true;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    const sessionWasActive = state === 'active' || state === 'username_required';
    if (sessionWasActive) {
      try { await client.rpc('dlmed_release_active_session'); } catch (_) {}
    }
    try { await client.auth.signOut({ scope: 'local' }); } catch (_) {}
    activeSession = null;
    activeUser = null;
    activeUsername = '';
    setStatus('anonymous');
    window.dispatchEvent(new CustomEvent('dlmed:auth-locked', { detail: { message: '' } }));
    mandatoryGate = pageIsQuiz;
    if (pageIsQuiz) showGate({ mandatory: true });
    else hideGateAfterAuthentication();
    signingOut = false;
  }

  function requestLogin({ mandatory = false, message = '' } = {}) {
    mandatoryGate = Boolean(mandatory || pageIsQuiz);
    showGate({ mandatory: mandatoryGate, message, username: state === 'username_required' });
  }

  async function ensureActiveSession() {
    if (!['active', 'username_required'].includes(state)) {
      requestLogin({ mandatory: true, message: state === 'locked' ? INVALID_SESSION_MESSAGE : '' });
      return false;
    }
    return checkActiveSession();
  }

  function handleAuthEvent(event, session) {
    if (signingOut) return;
    if (event === 'SIGNED_OUT') {
      if (state === 'active' || state === 'checking') void forceLocalSignOut('Ta session a expiré. Reconnecte-toi pour continuer.');
      else if (pageIsQuiz && state !== 'username_required') requestLogin({ mandatory: true });
      return;
    }
    if (session && ['SIGNED_IN', 'INITIAL_SESSION'].includes(event) && state !== 'active' && state !== 'username_required') {
      void establish(session).catch(async error => {
        if (await isSessionRevokedError(error)) await forceLocalSignOut(INVALID_SESSION_MESSAGE);
        else {
          setStatus('anonymous');
          requestLogin({ mandatory: pageIsQuiz, message: frenchError(error) });
        }
      });
    }
  }

  function attachGateTriggers() {
    const start = document.getElementById('openModulePicker');
    if (start) {
      let verifiedClick = false;
      start.addEventListener('click', event => {
        if (verifiedClick) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (state !== 'active') {
          setIntent('open-picker');
          requestLogin({ mandatory: false, message: state === 'locked' ? INVALID_SESSION_MESSAGE : '' });
          return;
        }
        void checkActiveSession().then(isActive => {
          if (!isActive) return;
          verifiedClick = true;
          start.click();
          verifiedClick = false;
        });
      }, true);
    }
    if (pageIsQuiz && state !== 'active' && state !== 'username_required') requestLogin({ mandatory: true });
  }

  window.DLMED_AUTH = Object.freeze({
    ready,
    get state() { return state; },
    get username() { return activeUsername; },
    isAuthorized: () => state === 'active',
    ensureActiveSession,
    requestLogin,
    logout
  });

  if (!client) {
    mountGate();
    setStatus('anonymous');
    requestLogin({ mandatory: pageIsQuiz, message: 'Le service d’authentification est indisponible. Réessaie après avoir rechargé la page.' });
  } else {
    mountGate();
    attachGateTriggers();
    client.auth.onAuthStateChange((event, session) => {
      window.setTimeout(() => handleAuthEvent(event, session), 0);
    });
    client.auth.getSession().then(({ data, error }) => {
      if (error) throw error;
      if (!data.session) {
        setStatus('anonymous');
        if (pageIsQuiz || window.DLMED_OAUTH_ERROR) {
          requestLogin({ mandatory: pageIsQuiz, message: window.DLMED_OAUTH_ERROR ? frenchError(window.DLMED_OAUTH_ERROR) : '' });
          clearOAuthPending();
        }
        return;
      }
      return establish(data.session).catch(async sessionError => {
        if (await isSessionRevokedError(sessionError)) await forceLocalSignOut(INVALID_SESSION_MESSAGE);
        else {
          setStatus('anonymous');
          requestLogin({ mandatory: pageIsQuiz, message: frenchError(sessionError) });
        }
      });
    }).catch(error => {
      setStatus('anonymous');
      requestLogin({ mandatory: pageIsQuiz, message: frenchError(error) });
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state === 'active') void checkActiveSession();
  });
  window.addEventListener('online', () => {
    if (state === 'locked' && activeSession) void checkActiveSession();
  });
})();
