import { onCleanup } from "solid-js"
import type { Server } from "@/server"
import { sessionComposerKey } from "../store"
import { createConfigOptionsProbe } from "./config-options-probe"
import type { DraftDefaultStorage } from "./draft-defaults"
import { createHarnessStore } from "./harness-store"
import { harnessOptionsReads, harnessSelectionReads } from "./harness-store-reads"
import { rememberDraftModelInWorkspace, resolveCurrentDraftDefault, wireHydrator, wireModelWriter, wireOptionsLoader, wireSwitcher, type FetchConfigOptions, type HarnessWiring } from "./harness-wiring"
import { createScopeCaches } from "./scope-caches"
import { applyPushedHarnessHealth, commitHeldHarness, probeHarnessHealth } from "./session-harness"

export function createHarnessConfigStore(server: Server, storage: DraftDefaultStorage) {
  const store = createHarnessStore(storage)
  const wiring: HarnessWiring = { server, api: server.harnessConfig, store, caches: createScopeCaches(), hasConfigOptions: createConfigOptionsProbe(server) }
  const optionsLoader = wireOptionsLoader(wiring)
  const fetchConfigOptions: FetchConfigOptions = (scope, type, input) =>
    optionsLoader.load(scope, type, store.heldHarness(scope) && input ? { ...input, sessionId: undefined } : input)
  const hydrator = wireHydrator(wiring, fetchConfigOptions)
  const modelWriter = wireModelWriter(wiring, fetchConfigOptions)
  const switcher = wireSwitcher(wiring, fetchConfigOptions)
  onCleanup(
    server.subscribe((event) => {
      if (event.type !== "harnessHealthChanged") return
      applyPushedHarnessHealth(wiring, sessionComposerKey(event.ref), { harnessHealth: event.health, connectionState: event.connectionState })
    }),
  )
  return {
    hydrate: hydrator.hydrate,
    reprobe: hydrator.reprobe,
    commitHeldHarness: commitHeldHarness.bind(null, wiring),
    probeHealth: probeHarnessHealth.bind(null, wiring),
    markUnavailable: (scope: string) => store.setReadiness(scope, "error"),
    promote: store.promote,
    rememberDraftModel: rememberDraftModelInWorkspace.bind(null, wiring),
    resolveDraftDefault: resolveCurrentDraftDefault.bind(null, wiring),
    setModel: modelWriter.setModel,
    settledModel: modelWriter.settledModel,
    setHarness: ((scope, type, input) => {
      hydrator.cancel(scope)
      return switcher.setHarness(scope, type, input)
    }) satisfies typeof switcher.setHarness,
    releaseHeldHarness: store.releaseHeldHarness,
    setConnectionDeclaration: store.setConnectionDeclaration,
    setThoughtLevel: store.setThoughtLevel,
    setServiceTier: store.setServiceTier,
    readiness: (scope: string) => store.read(scope).readiness,
    connectionState: (scope: string) => store.read(scope).connectionState,
    ...harnessSelectionReads(store.read),
    ...harnessOptionsReads(store.read),
  }
}

export type HarnessConfigStore = ReturnType<typeof createHarnessConfigStore>
