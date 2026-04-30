# Claxedo Sandbox Proxy Worker

Thin Cloudflare Worker that wraps `@cloudflare/sandbox` over HTTP so claxedo-server can control sandboxes from Node.js.

## Status: Experimental

Cloudflare Sandbox's `exposePort` requires wildcard subdomains (e.g., `*.sandbox.yourdomain.com`) which need:
- A custom domain on Cloudflare (not `.workers.dev`)
- Wildcard DNS record (`*.sandbox` → Worker)
- **Advanced Certificate Manager** ($10/mo) for wildcard SSL coverage

Without these, sandbox creation and command execution work, but the workspace-runtime health check will fail because the preview URL isn't accessible over HTTPS.

## Setup

```bash
cd packages/claxedo-server/src/cloud/cloudflare-worker
npm install
wrangler login
wrangler deploy
wrangler secret put API_TOKEN
```

## Custom domain setup (required for full functionality)

1. Add DNS records in Cloudflare dashboard for your domain:
   - `CNAME` | `sandbox` → `claxedo-sandbox-proxy.<subdomain>.workers.dev` | Proxied
   - `CNAME` | `*.sandbox` → `claxedo-sandbox-proxy.<subdomain>.workers.dev` | Proxied

2. Order Advanced Certificate (SSL/TLS → Edge Certificates) covering `*.sandbox.yourdomain.com`

3. Update `wrangler.toml` routes to use your domain

## Configure claxedo-server

Add to `.env`:

```
CLOUDFLARE_API_TOKEN=<the token you set above>
CLOUDFLARE_SANDBOX_WORKER_URL=https://sandbox.yourdomain.com
```

Then set `default_provider: "cloudflare"` in your sandbox config, or run the live test:

```bash
SANDBOX_PROVIDER=cloudflare node --import tsx src/cloud/live-test.ts
```
