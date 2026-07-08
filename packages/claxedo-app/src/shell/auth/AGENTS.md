# Auth Layer

Owns principals, placements, roles, and capability checks. UI surfaces consume
auth APIs; auth must not consume UI surfaces.

```json
{
  "owns": "Principal, Placement, RolePolicy, PrincipalPolicy, capability checks",
  "writerOf": [],
  "mustNotImport": ["@/components/*", "../data/*"]
}
```
