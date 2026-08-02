# Notifications Capability

Browser notification permission, click handling, sound playback, and headless
notification adapters shared by product features. Application provider
composition remains under `app/`.

```json
{
  "owns": "Browser notification and sound adapters",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/*", "@/shell/*", "@/context/*", "@/components/*", "@/claxedo-ui/*", "@/ui/*"]
}
```
