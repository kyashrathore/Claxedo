# Marketplace Surface

The extension marketplace UI (`panel.tsx`, `cards.tsx`, `filters.tsx`) plus its
Solid-independent data layer: catalog / installed / scan JSON validators and
networking helpers (`install-flow.ts`) and the themed confirm dialog
(`confirm-dialog.tsx`) that replaced native `confirm()`. The data layer is unit
tested directly (`install-flow.test.ts`); keep new parsing/networking logic
there, not inline in the Solid components.

`transport.ts` owns the one question the panel must not answer itself: WHICH
MACHINE serves an extensions request. It resolves the focused workspace's
record and takes the same placement branch `platform/runtime/http-backend.ts`
takes — central for a local workspace, that workspace's runtime transport for a
cloud or user-hosted one. No component may build an extensions base URL.

```json
{
  "owns": "Marketplace panel UI + catalog/install data layer + confirm dialog",
  "writerOf": [],
  "mustNotImport": ["@/claxedo-ui/*", "@claxedo/claxedo-ui/*", "../claxedo-ui/*", "@/pages/*", "../pages/*", "@/session/*", "../session/*", "@/terminal/*", "../terminal/*"]
}
```
