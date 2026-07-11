# Cloud Workspace Runtime Store

Cloud / user-hosted workspace provisioning and startup sequencing
(`workspace-runtime-store.ts` and the cloud-startup view it drives). Distinct
from `agent-runtime/` (general session routing) and from `context/` providers —
this owns the workspace lifecycle store, not per-session transport.

```json
{
  "owns": "Cloud/user-hosted workspace provisioning + startup sequencing store",
  "writerOf": [],
  "mustNotImport": ["@/claxedo-ui/*", "@claxedo/claxedo-ui/*", "../claxedo-ui/*", "@/pages/*", "../pages/*", "@opencode-ai/ui/*", "@/marketplace/*", "../marketplace/*"]
}
```
