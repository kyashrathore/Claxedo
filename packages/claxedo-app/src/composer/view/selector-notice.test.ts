/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import { connectionHarness, nativeHarness } from "@/lib/harness-selection"
import { placementId } from "@/server"
import { applyHarnessOptionsResponse } from "../harness/options-state"
import type { HarnessSelectionController, HarnessSelectionSnapshot } from "../harness/controller"
import type { HarnessType } from "../harness/profile"
import { createModelAvailability } from "./harness-model-availability"
import type { SelectorCatalog } from "./selector-catalog"
import type { HarnessAccountState } from "./harness-account-state"
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

type Situation = { account?: HarnessAccountState; asleep?: boolean }

function harnessNotice(
  harness: HarnessType,
  answered: (harness: HarnessType) => HarnessSelectionSnapshot = (type) => snapshot(type, true),
  situation: Situation = {},
) {
  return createRoot((dispose) => {
    const [selection, setSelection] = createSignal(snapshot(harness, false))
    const [connection, setConnection] = createSignal<HarnessConnectionRef | undefined>(undefined)
    const catalog = {
      unread: () => false,
      providers: { resolved: () => true, loading: () => false, error: () => undefined, refresh: async () => undefined },
      rows: () => ({ rows: [] }),
    } as unknown as SelectorCatalog
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
      asleep: () => situation.asleep === true,
      account: () => situation.account ?? (harness.kind === "connection" ? "accountless" : "missing"),
      harnessLabel: () => "Scripted",
      openProviders: () => undefined,
    })
    return {
      kind: () => notice()?.kind,
      answerOptions: () => setSelection(answered(harness)),
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

test("selector notice: a harness whose live options answer offers no model asks for a provider, not a retry", () => {
  const pi = nativeHarness("pi")
  const view = harnessNotice(pi, (type) => {
    const { patch } = applyHarnessOptionsResponse({ type, payload: { source: "harness", stale: false, offersOptions: false, serviceTiers: [] } })
    return { ...snapshot(type, true), configError: patch.configError, optionsLoading: patch.optionsLoading ?? false }
  })
  view.answerOptions()
  expect(view.kind()).toBe("setup-required")
  view.dispose()
})

const piAnsweredEmpty = (type: HarnessType) => {
  const { patch } = applyHarnessOptionsResponse({ type, payload: { source: "harness", stale: false, offersOptions: false, serviceTiers: [] } })
  return { ...snapshot(type, true), configError: patch.configError, optionsLoading: patch.optionsLoading ?? false }
}

test("selector notice: a harness whose account source holds an account is never called not set up, whatever its live options say", () => {
  const codex = harnessNotice(nativeHarness("codex"), undefined, { account: "present" })
  codex.answerOptions()
  expect(codex.kind()).not.toBe("setup-required")
  codex.dispose()
  const pi = harnessNotice(nativeHarness("pi"), piAnsweredEmpty, { account: "present" })
  pi.answerOptions()
  expect(pi.kind()).not.toBe("setup-required")
  pi.dispose()
})

test("selector notice: an account source still loading claims nothing", () => {
  const view = harnessNotice(nativeHarness("codex"), undefined, { account: "unknown" })
  view.answerOptions()
  expect(view.kind()).toBeUndefined()
  view.dispose()
})

test("selector notice: on an asleep workspace every harness says a send wakes it, never that it is not set up", () => {
  for (const harness of [nativeHarness("opencode"), nativeHarness("pi"), nativeHarness("codex"), scripted]) {
    const view = harnessNotice(harness, piAnsweredEmpty, { asleep: true, account: harness.kind === "connection" ? "accountless" : "missing" })
    view.answerOptions()
    view.answerConnection()
    expect(view.kind(), JSON.stringify(harness)).toBe("workspace-asleep")
    view.dispose()
  }
})
