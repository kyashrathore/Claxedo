# Cloudflare outbound feasibility

This isolated experiment uses the production `Sandbox` class, its native
credential handler, the runtime Dockerfile, SDK 0.12.9, and a local KV binding.
Node and Bun each stay in one process through initial authentication, KV
credential rotation, and withdrawal. A separate HTTPS upstream Worker verifies
the fixture header and returns only an authentication verdict and revision.
No provider account credential is used.

Build the host from `scripts/sandbox`:

```sh
bun build-sandbox-image.ts --bundle-only --out=cloudflare-worker/.build
```

From `cloudflare-worker`, deploy the temporary upstream:

```sh
npx wrangler deploy --config feasibility/upstream/wrangler.toml
npx wrangler secret put PROBE_TOKEN --config feasibility/upstream/wrangler.toml
```

Use a fresh random test token. Create ignored `feasibility/.dev.vars` with that
same `PROBE_TOKEN` and `UPSTREAM_ORIGIN` set to the returned HTTPS Worker origin.
Supply the same token as `BROKER_PROBE_TOKEN` to the checker process. The token
stays in controller bindings; sandbox clients receive only a named placeholder.
Every sandbox operation requires an authenticated POST, and an unset token
leaves the probe disabled.

Start Docker and run:

```sh
npx wrangler dev --config feasibility/wrangler.toml --port 8793
```

Once the image is ready, run `node feasibility/check.mjs` in another terminal.
The checker requires six HTTPS responses and stable client PIDs. Revisions 1
and 2 must authenticate; withdrawal must return 401 or 403. It destroys the
sandbox and clears the KV registration even on failure. Delete the upstream
Worker afterward:

```sh
npx wrangler delete --config feasibility/upstream/wrangler.toml --force
```

Verified locally on 2026-09-13: six requests passed, both original client
processes survived rotation and withdrawal, and both withdrawal requests returned
401. Sandbox cleanup and upstream Worker deletion passed. This is local
workerd/Docker interception forwarding to a deployed HTTPS fixture, not a
sandbox running on deployed Cloudflare Containers. KV propagation semantics on
the deployed platform remain unverified.

The earlier synthetic-handler probe passed four Node/Bun requests. It established
the SDK's inherited handler setter and `enable_ctx_exports` requirements; the
current probe extends that proof to the production handler and actual upstream
forwarding. Deployed Container attempts failed twice during image upload with
`use of closed network connection`; their temporary Worker was deleted.

For a deployed Container probe, first create an isolated KV namespace and replace
the local-only all-zero id in a temporary configuration. Deploy under the probe
name, configure its token and upstream origin, and set `BROKER_PROBE_ORIGIN` to
its returned URL. Delete that Worker, namespace and upstream fixture afterward.
Never point this configuration at production sandbox resources.
