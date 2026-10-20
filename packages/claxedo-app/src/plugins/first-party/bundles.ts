import type { FirstPartyBundle } from "./model"

export const FIRST_PARTY_BUNDLES: readonly FirstPartyBundle[] = [
  { id: "claxedo-tasks", load: () => import("@claxedo/tasks/app?claxedo-plugin-bundle") },
  { id: "claxedo-documents", load: () => import("@claxedo/documents/app?claxedo-plugin-bundle") },
]
