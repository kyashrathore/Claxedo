# User Extensions Layer

Owns the user-extension runtime: the loader that fetches extension manifests
from the loopback control plane, imports each entry module at runtime, and
hands it the frozen v1 activation API — plus the reactive registry of views
those activations contribute. The workbench host surface and the command
palette read the registry; nothing in this layer knows about panes, routes, or
any specific feature, so it must not reach up into app or feature code.

```json
{
  "owns": "user-extension loading, the v1 activation API, and the registry of extension-contributed views",
  "writerOf": [],
  "mustNotImport": ["@tanstack/*", "@opencode-ai/sdk*", "@/components/*", "@/features/*", "@/app/*", "@/ui/*"]
}
```
