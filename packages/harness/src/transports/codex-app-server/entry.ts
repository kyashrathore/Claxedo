import type { AsyncPushQueue } from "@claxedo/helpers"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import type { HarnessSession, RoutedEvent, SessionBroker, StartInput, TransportConfigUpdate, TurnBroker } from "../../contract"
import type { CodexChildren } from "./children"
import type { CodexModel } from "./models"
import type { CodexProviderTurn } from "./provider-turn"
import type { CodexMember } from "./member"
import type { CodexTerminals } from "./terminals"
import type { CodexUsageLedger } from "./usage"

export type CodexTransportOptions = { binary: string; homeRoot: string; ownerHome?: string; env?: NodeJS.ProcessEnv; idleMs?: number }

export type EntryState = "ready" | "busy" | "lost" | "retiring"

export type Entry = {
  state: EntryState
  start: StartInput
  session: HarnessSession
  broker: SessionBroker
  rpc: CodexMember
  key: string
  release: () => Promise<void>
  home: string
  modelProvider: string
  terminals: CodexTerminals
  children: CodexChildren
  sideThreads: Set<string>
  usage: CodexUsageLedger
  goal: RuntimeGoalSnapshot | null
  models?: Promise<CodexModel[]>
  steers: Set<string>
  released: Promise<void>
  pendingUpdate?: TransportConfigUpdate
  idle(): void
  providerTurn?: CodexProviderTurn
  turn?: { broker: TurnBroker; queue: AsyncPushQueue<RoutedEvent>; id?: string; started: Promise<void>; closing?: boolean }
}
