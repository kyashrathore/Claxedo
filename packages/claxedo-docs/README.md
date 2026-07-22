# @claxedo/docs

The legacy Mintlify authoring source for Claxedo developer documentation. The canonical public documentation now builds at **claxedo.com/framework** from `packages/claxedo-web`.

This package remains deployable during migration so `docs.claxedo.com` can stay available until the complete one-hop redirect report passes against the production edge. Do not retire it or move DNS based on repository tests alone.

This is a **separate** site from the upstream `packages/docs/` Mintlify
starter boilerplate. Content is **assembled** from the source-of-truth
material — do not fork a second narrative that can drift:

- `public-docs/*.md` — guides, deployment, MCP.
- The per-package `README.md` files — package reference + API tables.
- `claxedo-cookbook/` — runnable examples.

## Develop

```sh
cd packages/claxedo-docs
npx mintlify dev            # local preview at http://localhost:3000
npx mintlify broken-links   # link check (run before pushing)
```

## Structure

- `docs.json` — navigation, theme, branding.
- `guides/`, `concepts/`, `deploy/` — the Guides tab.
- `packages/` — one page per `@claxedo/*` package.
- `api/` — hand-written route/tool reference tables (kept in sync with code).
- `cookbook/` — the runnable-examples tab.

## Truthfulness gate

Every code example must compile against the real package exports, and every
route/tool table must match the code. This is the release gate — the same
check that caught the pre-launch README bugs. When a package's API changes,
update the corresponding page (or the README it links to).

## Deploy

1. Install the [Mintlify GitHub app](https://dashboard.mintlify.com) on the
   `kyashrathore/Claxedo` repo and point it at this directory
   (`packages/claxedo-docs`). It builds on every push and posts preview
   deploys on PRs.
2. Preserve the `docs.claxedo.com` custom domain until the redirect manifest in `packages/claxedo-web/deploy/redirects.json` is bound and verified in production.

The site has no build step of its own beyond Mintlify's — there is nothing to
publish to npm (`private: true`).
