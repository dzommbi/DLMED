// This publishable key is intended for browser use. Never place a Supabase secret key here.
window.DLMED_SUPABASE_CONFIG = Object.freeze({
  url: 'https://alfziyssfhiabqgmzlsb.supabase.co',
  publishableKey: 'sb_publishable_J8nRfpA8KbJdW4Mdn9DaoA_ZnGXS7lW'
});

if (window.supabase?.createClient) {
  window.DLMED_SUPABASE = window.supabase.createClient(
    window.DLMED_SUPABASE_CONFIG.url,
    window.DLMED_SUPABASE_CONFIG.publishableKey,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  );
} else {
  window.DLMED_SUPABASE_ERROR = 'Le client Supabase ne s’est pas chargé.';
}
