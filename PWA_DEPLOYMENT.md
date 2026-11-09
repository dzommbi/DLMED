# DLMed automatic PWA updates

The Pages build stamps every deployment with its Git commit SHA. The generated `sw.js`, `dlmed-version.json`, and same-origin JavaScript/CSS URLs all use that release ID. The service worker checks on page load and every five minutes, activates the new worker, and removes only caches named `dlmed-shell-*`.

## One-time GitHub Pages setting

In the repository, open **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**. The workflow at `.github/workflows/pages.yml` then builds and deploys the static site from `main`. It uses the built-in `GITHUB_TOKEN` with only `contents: read`, `pages: write`, and `id-token: write`; no secret needs to be added.

## Cloudflare cache setting

If `dlmed.fyi` is proxied through Cloudflare, add a Cache Rule for host `dlmed.fyi` that bypasses the edge cache for `/`, `/index.html`, `/quiz.html`, `/exam.html`, `/privacy`, `/privacy/`, `/terms`, `/terms/`, all `*.html`, `*.js`, `*.mjs`, `*.css`, `/sw.js`, and `/dlmed-version.json`. Do not set an Edge TTL that overrides this bypass. Keep the existing DNS and Pages custom-domain configuration.

GitHub Pages does not read Cloudflare Pages `_headers` files, and repository files cannot change a Cloudflare zone's Cache Rules. The cache rule is required when the DNS record is proxied; otherwise the origin's revalidation and the versioned asset URLs are used.

## Verify a deployed release

After a successful **Deploy DLMed to GitHub Pages** workflow run, open `https://dlmed.fyi/dlmed-version.json`. Its `version` must equal the commit SHA shown by that deployment. The same value should appear as `APP_VERSION` in `https://dlmed.fyi/sw.js` and as `v=<SHA>` on local JavaScript/CSS resources in page source. A worker update purges only the prior `dlmed-shell-*` caches; it does not clear cookies, browser storage, Supabase data, or exam-attempt state.
