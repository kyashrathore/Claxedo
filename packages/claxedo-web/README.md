# @claxedo/web

The Astro application for Claxedo's canonical public site. It owns commercial pages, downloads, maintained comparisons, framework documentation, and machine-readable discovery on `claxedo.com`.

## Develop

```sh
cd packages/claxedo-web
bun run dev
```

## Quality gates

```sh
bun test test
bun run build
bunx playwright test
```

## Content contracts

- `src/content/site.ts` owns the product hierarchy and navigation language.
- `src/content/routes.ts` owns canonical public destinations and the two marketing actions.
- `src/content/claims.ts` gates high-risk public wording on named evidence and verification dates.
- `src/content/competitors.ts` owns comparison facts, sources, review dates, and publication state.

Public claims about synchronization, placement, hosted operation, source parity, licensing, releases, pricing, or lineage must have reproducible evidence in the claim registry. Withheld claims must remain out of rendered pages until their owner records current evidence. Comparison pages require first-party sources, visible ownership, a review deadline, and automatic expiry from discovery.

Framework code examples must compile against real exports and route/tool tables must match current implementation. When a package API changes, update its canonical framework page in the same change.
