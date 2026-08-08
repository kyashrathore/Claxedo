# Account Capability

The renderer's view of an account, and the closed set of authenticated
operations it may ask for by name. Product code asks this layer "who is signed
in" and "run this named operation"; it never builds an authenticated request and
never holds a credential.

The set of operations is fixed by
`docs/tech-docs/desktop-hosted-operation-matrix.md` and enforced by
`account-port.test.ts`. A generic `run(url, method, body)` here would make
Electron main a confused deputy, so the port cannot express one.

```json
{
  "owns": "The tokenless account port, its named hosted-operation set, and the browser binding",
  "writerOf": [],
  "mustNotImport": ["@/app/*", "@/features/*", "@/shell/*", "@/context/*", "@/components/*", "@/claxedo-ui/*", "@/ui/*"]
}
```
