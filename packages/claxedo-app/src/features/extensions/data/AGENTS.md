# Extensions Accessor

The extensions/agent-config accessor and its server client (`server.tsx`,
`app.tsx`, `types.ts`): reads/writes the claxedo-server agent-config surface.
Marketplace UI that consumes it lives in `marketplace/`.

```json
{
  "owns": "Extensions/agent-config accessor + server client",
  "writerOf": [],
  "mustNotImport": [
    "@/claxedo-ui/*",
    "../claxedo-ui/*",
    "@/components/*",
    "../components/*",
    "@/pages/*",
    "../pages/*",
    "@opencode-ai/ui/*"
  ]
}
```
