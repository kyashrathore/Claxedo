# Internationalization Capability

Locale manifests, dictionaries, loading, and language-provider behavior shared
across product features. Locale files depend only on library primitives and
external i18n/UI contracts; application composition supplies extension strings.

```json
{
  "owns": "Locale manifest, dictionaries, loading, and language provider",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/*", "@/shell/*", "@/context/*", "@/components/*", "@/claxedo-ui/*"]
}
```
