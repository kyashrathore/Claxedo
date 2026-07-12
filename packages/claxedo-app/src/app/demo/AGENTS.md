# Demo Mode

Demo-mode support: the MSW mock server (`handlers.ts`) and fixtures
(`fixtures.ts`), the renderless tour controller (`tour-controller.tsx`), and its
origin allow-list (`tour-origin.ts`). The tour controller drives navigation from
`postMessage`, so `tour-origin.ts` is a security boundary — keep the allow-list
strict. Demo code must not leak into production feature layers.

```json
{
  "owns": "Demo MSW mock server, fixtures, tour controller, tour-origin allow-list",
  "writerOf": [],
  "mustNotImport": ["@opencode-ai/ui/*", "@/components/*", "../components/*", "@/pages/*", "../pages/*"]
}
```
