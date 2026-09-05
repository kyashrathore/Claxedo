# Extensions Feature

Extension configuration and its server access form one vertical feature.
Marketplace discovery, installation, and workbench surfaces moved to
`features/agent-plugins/`.

```json
{
  "owns": "Extension configuration data and server access",
  "writerOf": [],
  "mustNotImport": ["@/features/browser/*", "@/features/processes/*", "@/features/session/*", "@/features/terminal/*", "@/app/*"]
}
```
