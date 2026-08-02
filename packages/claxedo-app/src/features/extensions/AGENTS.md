# Extensions Feature

Extension configuration, server access, marketplace discovery, confirmation,
installation, and marketplace workbench surfaces form one vertical feature.

```json
{
  "owns": "Extension configuration and marketplace data, UI, and workbench surfaces",
  "writerOf": [],
  "mustNotImport": ["@/features/browser/*", "@/features/processes/*", "@/features/session/*", "@/features/terminal/*", "@/app/*"]
}
```
