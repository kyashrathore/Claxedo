import type { SignedControlPlaneAuth } from "./auth"
import type { SessionReaderState, SessionReaderWrite } from "../../session/reader"

export type RecordedSessionReader = SessionReaderState & { workspaceId: string }

/**
 * The hosted store of each reader's marks, keyed by the reader's account. A
 * write is authorized as a read of the session; it answers nothing when the
 * caller cannot read the session.
 */
export type SessionReaderAuthority = {
  recordSessionReader: (
    auth: SignedControlPlaneAuth,
    input: { sessionId: string; write: SessionReaderWrite },
  ) => Promise<RecordedSessionReader | undefined>
}
