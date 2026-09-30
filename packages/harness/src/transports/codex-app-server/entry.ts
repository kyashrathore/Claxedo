import type { AsyncPushQueue } from "@claxedo/helpers"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import type { HarnessSession, RoutedEvent, SessionBroker, StartInput, TransportConfigUpdate, TurnBroker } from "../../contract"
import type { CodexEvents } from "./events"
import type { CodexModel, CodexTurnSettings } from "./models"
import type { CodexProviderTurn } from "./provider-turn"
import type { CodexRpc } from "./rpc"
import type { CodexTerminals } from "./terminals"
import type { CodexUsageLedger } from "./usage"

export type CodexTransportOptions = { binary: string; homeRoot: string; ownerHome?: string; env?: NodeJS.ProcessEnv }

export type EntryState = "ready" | "busy" | "lost" | "retiring"

export type Entry = {
  state: EntryState
  start: StartInput
  session: HarnessSession
  broker: SessionBroker
  rpc: CodexRpc
  home: string
  brokered: boolean
  terminals: CodexTerminals
  children: Map<string, CodexEvents>
  sideThreads: Set<string>
  usage: CodexUsageLedger
  goal: RuntimeGoalSnapshot | null
  settings: CodexTurnSettings
  models?: Promise<CodexModel[]>
  pendingUpdate?: TransportConfigUpdate
  idle(): void
  providerTurn?: CodexProviderTurn
  turn?: { broker: TurnBroker; queue: AsyncPushQueue<RoutedEvent>; id?: string; started: Promise<void>; steers: Set<string> }
}
