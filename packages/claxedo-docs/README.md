# @claxedo/docs

**This directory is the canonical source for the published Claxedo developer
documentation.** Both live surfaces come from the `.mdx` tree here:

- **`claxedo.com/framework`** — `packages/claxedo-web/scripts/sync-framework-docs.ts`
  copies every page except `index.mdx` into
  `packages/claxedo-web/src/content/docs/framework/` and the Astro site builds
  them. The generated tree is output, never edited by hand; `bun run check:framework`
  in `packages/claxedo-web` fails if it drifts.
- **`docs.claxedo.com`** — the Mintlify GitHub app builds this directory directly
  on every push (see [Deploy](#deploy)).

`index.mdx` is the one page that is *not* synced; it is served as the standalone
`packages/claxedo-web/src/pages/framework.astro` landing instead.

Retiring `docs.claxedo.com` means binding the redirect manifest in
`packages/claxedo-web/deploy/redirects.json` and verifying the one-hop redirect
report against the production edge first. Do not move DNS on the strength of
repository tests alone.

This is a **separate** site from the upstream `packages/docs/` Mintlify starter
boilerplate. Pages here are written by hand and must stay consistent with the
material they describe — do not fork a second narrative that can drift:

- `public-docs/*.md` — deployment runbooks and engineering reference.
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
