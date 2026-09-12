# Cloudflare outbound feasibility

Local-only experiment for design 002 Appendix E item 3. It uses the production Dockerfile and freshly bundled host, SDK 0.12.9, and the production compatibility date. The Worker answers intercepted requests to a synthetic `.invalid` host; no provider credential or deployed Worker is used. Do not deploy this unauthenticated experiment.

From `scripts/sandbox`, build the host:

```sh
bun build-sandbox-image.ts --bundle-only --out=cloudflare-worker/.build
```

From `cloudflare-worker`, start Docker and run:

```sh
npx wrangler dev --config feasibility/wrangler.toml --port 8793
```

Once the image is ready, run in another terminal:

```sh
node feasibility/check.mjs
```

The check calls both Node and Bun inside one sandbox before and after `setOutboundByHost` updates the handler parameters. All four HTTPS calls must reach the Worker with the expected revision and dummy request header. The script destroys its sandbox even on failure. This is local container evidence, not a deployed Cloudflare result.
