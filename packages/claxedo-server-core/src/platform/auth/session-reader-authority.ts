import type { SessionReaderCommand, SessionReaderResult } from "@claxedo/agent-runtime-contract"
import type { SignedControlPlaneAuth } from "./auth"
import type { AuthoritySessionInventoryRow } from "./session-inventory-authority"
import type { SessionPageQuery } from "./private-session-authority"

export type SessionCleanupPrincipal = { actorId: string; userId: string; orgId: string }
export type SessionCleanupTarget = { sessionId: string; workspaceId: string; generation: number; readerRevision: number }

/** Reader persistence and destructive-operation admission over that exact reader version. */
export type SessionReaderAuthority = {
  writeSessionReader?: (auth: SignedControlPlaneAuth, args: { sessionId: string; workspaceId: string; command: SessionReaderCommand }) => Promise<SessionReaderResult>
  admitSessionCleanup?: (auth: SignedControlPlaneAuth, target: SessionCleanupTarget) => Promise<void>
  listSessionCleanupPage?: (principal: SessionCleanupPrincipal, query: SessionPageQuery) => Promise<AuthoritySessionInventoryRow[]>
  admitRuntimeSessionCleanup?: (principal: SessionCleanupPrincipal, target: SessionCleanupTarget) => Promise<void>
}
