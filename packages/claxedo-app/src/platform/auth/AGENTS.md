# Authentication Capability

Authentication session state, principal identity, role policy, and credential
token access. UI and app composition consume auth contracts; auth remains
headless apart from its colocated Solid providers.

```json
{
  "owns": "Authentication session, principals, role policy, and credential token access",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/*", "@/shell/*", "@/context/*", "@/components/*", "@/claxedo-ui/*", "@/ui/*"]
}
```
