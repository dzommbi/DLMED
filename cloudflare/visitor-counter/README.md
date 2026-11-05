# DLMED live online counter (Cloudflare Worker + D1)

The welcome screen shows only the number of distinct IP addresses that contacted the counter in the last 90 seconds. The browser sends a heartbeat every 30 seconds. Visitors behind one shared public IP count as one.

The Worker never writes a raw IP to D1. It uses a keyed HMAC-SHA-256 fingerprint for the short-lived online presence record. The site displays a dash until the Worker is deployed and connected.

## Deploy the counter

You need a Cloudflare account and Node.js/npm on the computer used for setup.

1. The GitHub Pages origin is already set to https://dzommbi.github.io. The /DLMED path is not part of the origin.
2. Open PowerShell in this folder and sign in:

   npx wrangler@latest login

3. Create the D1 database:

   npx wrangler@latest d1 create dlmed-visitor-counter

   Copy the returned database_id into wrangler.jsonc, replacing the all-zero UUID used as the placeholder.
4. Create the table:

   npx wrangler@latest d1 migrations apply dlmed-visitor-counter --remote

5. Generate a private key in PowerShell:

   [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))

   Then set it as a Cloudflare secret. Paste the generated value when Wrangler prompts:

   npx wrangler@latest secret put IP_HASH_SECRET

6. Publish the Worker:

   npx wrangler@latest deploy

   Wrangler prints a URL similar to https://dlmed-visitor-counter.YOUR-SUBDOMAIN.workers.dev.
7. Open visitor-counter-config.js in the website files and set that URL:

   window.DLMED_VISITOR_COUNTER_URL = 'https://dlmed-visitor-counter.YOUR-SUBDOMAIN.workers.dev';

8. Push the updated website files to GitHub Pages. The online number will then refresh every 30 seconds.

Cloudflare D1 access is through the Worker binding declared in wrangler.jsonc. See the official D1 Workers Binding API at https://developers.cloudflare.com/d1/worker-api/ and Wrangler configuration at https://developers.cloudflare.com/workers/wrangler/configuration/.