# Extensions Accessor

The extensions/agent-config accessor and its server client (`server.tsx`,
`app.tsx`, `types.ts`): reads/writes the claxedo-server agent-config surface.
The agent-plugins directory UI (`features/agent-plugins/directory/`) is a
separate feature and may not import this accessor.

```json
{
  "owns": "Extensions/agent-config accessor + server client",
  "writerOf": [],
  "mustNotImport": ["@opencode-ai/ui/*"]
}
```
