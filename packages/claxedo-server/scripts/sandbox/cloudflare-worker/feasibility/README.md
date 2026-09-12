# Cloudflare outbound feasibility

Isolated experiment for design 002 Appendix E item 3. It uses the production Dockerfile and freshly bundled host, SDK 0.12.9, and the production compatibility date. The Worker answers intercepted requests to a synthetic `.invalid` host; no provider credential is used. Every sandbox operation requires a bearer token and POST; an unset token disables the probe.

From `scripts/sandbox`, build the host:

```sh
bun build-sandbox-image.ts --bundle-only --out=cloudflare-worker/.build
```

Create an ignored `feasibility/.dev.vars` containing `PROBE_TOKEN=<random test token>`. Set the same value as `BROKER_PROBE_TOKEN` in the check process. From `cloudflare-worker`, start Docker and run:

```sh
npx wrangler dev --config feasibility/wrangler.toml --port 8793
```

Once the image is ready, run in another terminal:

```sh
node feasibility/check.mjs
```

The check calls both Node and Bun inside one sandbox before and after `setOutboundByHost` updates the handler parameters. All four HTTPS calls must reach the Worker with the expected revision and dummy request header. The script destroys its sandbox even on failure. This is local container evidence, not a deployed Cloudflare result.

Verified locally on 2026-09-13: all four requests and sandbox cleanup passed on SDK 0.12.9, with the current runtime image (host build ID `195438cb63`). Native outbound handlers require the probe's `enable_ctx_exports` flag at the retained compatibility date. Registration must invoke the SDK's inherited setter; a static class field with the same name does not populate its handler registry. Deployed acceptance remains pending.

For an isolated deployed run, deploy this configuration under its dedicated probe name and set `PROBE_TOKEN` using `wrangler secret put PROBE_TOKEN --config feasibility/wrangler.toml`. Set `BROKER_PROBE_ORIGIN` to the returned Worker origin and run the same check. The check verifies unauthenticated rejection before exercising the container and destroys the sandbox afterward. Delete the temporary Worker with `wrangler delete --config feasibility/wrangler.toml --force` when done. Do not point this configuration at the production Worker.

Deployed attempts on 2026-09-13 failed twice while uploading image layers (`use of closed network connection`). The temporary Worker was deleted successfully, and the container application list contained no matching probe application. Deployed interception is still unverified.
