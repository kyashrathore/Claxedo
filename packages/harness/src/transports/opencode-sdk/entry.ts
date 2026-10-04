import type { HarnessSession, ScopedSessionTools, SessionBroker, StartInput } from "../../contract"
import type { WorkspaceScope } from "./scope.js"

export type Entry = { session: HarnessSession; start: StartInput; broker: SessionBroker; scope: WorkspaceScope;
  upstream: string; active: boolean; assistantMessageID?: string; steers: Set<string>; pendingInstance?: string; firstParty?: ScopedSessionTools; scoped?: ScopedSessionTools }
