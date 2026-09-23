# Settings Feature

Settings screens for account, providers, models, connections, network policy, sandbox behavior, keybinds, terminals, and remote access (`remote-access/`: the machine-publication controller and surface, the second-device marker, and per-machine provider configuration).

```json
{
  "owns": "Application settings screens, settings-specific interaction logic, and the remote-access panel",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/browser/*", "@/features/documents/*", "@/features/extensions/*", "@/features/processes/*", "@/features/review/*", "@/features/session/*", "@/features/terminal/*", "@/features/workspaces/*", "@/shell/*", "@/context/*", "@/components/*", "@/pages/*", "@/claxedo-ui/*", "@/pane/*", "@/shared/*"]
}
```
