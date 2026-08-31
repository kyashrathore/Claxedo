# Agent Plugins Feature

The standard plugin catalog client and activation UI form one vertical feature.
Product composition owns whether this feature is present in a build.

```json
{
  "owns": "Agent Plugins catalog transport and activation UI",
  "writerOf": [],
  "mustNotImport": ["@/features/browser/*", "@/features/extensions/*", "@/features/processes/*", "@/features/session/*", "@/features/terminal/*", "@/app/*"]
}
```
