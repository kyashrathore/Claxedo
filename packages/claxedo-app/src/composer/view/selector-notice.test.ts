/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import { connectionHarness, nativeHarness } from "@/lib/harness-selection"
import { placementId } from "@/server"
import type { HarnessSelectionController, HarnessSelectionSnapshot } from "../harness/controller"
import type { HarnessType } from "../harness/profile"
import { createModelAvailability } from "./harness-model-availability"
import type { SelectorCatalog } from "./selector-catalog"
import { createSelectorNotice } from "./selector-notice"

const scripted = connectionHarness("scripted")

const declaration: HarnessConnectionRef = {
  connectionId: "scripted",
  label: "Scripted",
  enabled: true,
  readiness: "ready",
  capabilities: { abort: true, reconnect: false, replay: true, permissions: true, questions: false, todos: false, commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: false },
}

function snapshot(harness: HarnessType, optionsAnswered: boolean): HarnessSelectionSnapshot {
  return {
    harness,
    isHarnessMode: true,
    readiness: "ready",
    models: [],
    selectedModel: "",
    thoughtLevels: [],
    selectedThoughtLevel: undefined,
    serviceTiers: [],
    selectedServiceTier: undefined,
    optionsStale: false,
    optionsLoading: false,
    optionsAnswered,
    configError: undefined,
  }
}

function harnessNotice(harness: HarnessType) {
  return createRoot((dispose) => {
    const [selection, setSelection] = createSignal(snapshot(harness, false))
    const [connection, setConnection] = createSignal<HarnessConnectionRef | undefined>(undefined)
    const catalog = { unread: () => false } as unknown as SelectorCatalog
    const availability = createModelAvailability({ harness: () => harness, selection, connectionDeclaration: connection, catalog, rows: () => [], switching: () => false })
    const { notice } = createSelectorNotice({
      active: () => true,
      controller: () => ({}) as HarnessSelectionController,
      scope: () => "session:ses_1",
      scopeInput: () => ({ placementId: placementId("placement") }),
      selection,
      harness: () => harness,
      picked: () => undefined,
      catalog,
      availability,
      polling: () => false,
      harnessLabel: () => "Scripted",
      openProviders: () => undefined,
    })
    return {
      kind: () => notice()?.kind,
      answerOptions: () => setSelection(snapshot(harness, true)),
      answerConnection: () => setConnection(declaration),
      dispose,
    }
  })
}

test("selector notice: a connection claims no setup until its declaration and its options have answered", () => {
  const view = harnessNotice(scripted)
  expect(view.kind(), "neither the connection list nor the options have answered").toBeUndefined()
  view.answerOptions()
  expect(view.kind(), "the options answered, the connection list has not").toBeUndefined()
  view.answerConnection()
  expect(view.kind(), "a connection that declares no model selection and offers no model").toBe("setup-required")
  view.dispose()
})

test("selector notice: a native harness claims no setup until its options have answered", () => {
  const view = harnessNotice(nativeHarness("codex"))
  expect(view.kind(), "the options have not answered").toBeUndefined()
  view.answerOptions()
  expect(view.kind(), "the options answered with no model").toBe("setup-required")
  view.dispose()
})
