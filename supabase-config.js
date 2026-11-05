// This publishable key is intended for browser use. Never place a Supabase secret key here.
window.DLMED_SUPABASE_CONFIG = Object.freeze({
  url: 'https://alfziyssfhiabqgmzlsb.supabase.co',
  publishableKey: 'sb_publishable_J8nRfpA8KbJdW4Mdn9DaoA_ZnGXS7lW'
});

window.DLMED_OAUTH_CALLBACK = /(?:\?|&)code=/.test(window.location.search)
  || /(?:^|[&#])access_token=/.test(window.location.hash);
window.DLMED_OAUTH_ERROR = new URLSearchParams(window.location.search).get('error')
  || new URLSearchParams(window.location.hash.replace(/^#/, '')).get('error')
  || '';

if (window.supabase?.createClient) {
  window.DLMED_SUPABASE = window.supabase.createClient(
    window.DLMED_SUPABASE_CONFIG.url,
    window.DLMED_SUPABASE_CONFIG.publishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce'
      }
    }
  );
} else {
  window.DLMED_SUPABASE_ERROR = 'Le client Supabase ne s’est pas chargé.';
}
