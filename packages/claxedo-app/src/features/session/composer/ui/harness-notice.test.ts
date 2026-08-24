import { describe, expect, test } from "bun:test"
import { resolveHarnessNotice, type HarnessNoticeInput } from "./harness-notice"

const healthy: HarnessNoticeInput = {
  harnessLabel: "Cursor",
  runtimeUnavailable: false,
  optionsFailed: false,
  noModels: false,
  piModelMissing: false,
}

describe("resolveHarnessNotice", () => {
  test("a healthy harness produces no notice", () => {
    expect(resolveHarnessNotice(healthy)).toBeUndefined()
  })

  test("a settled runtime failure is critical, retryable, and names the harness", () => {
    const notice = resolveHarnessNotice({ ...healthy, runtimeUnavailable: true })

    expect(notice).toMatchObject({
      kind: "runtime-unavailable",
      tone: "critical",
      message: "Cursor runtime is unavailable",
      retry: true,
    })
  })

  test("the runtime title stays byte-exact — the harness e2e specs select on it", () => {
    expect(resolveHarnessNotice({ ...healthy, runtimeUnavailable: true })?.title).toBe(
      "Agent runtime unreachable after timeout",
    )
  })

  // The whole reason this is one function: these conditions co-occur, and the
  // old UI rendered a widget for each — which is how the control row ended up
  // showing "Unavailable ● Retry" side by side.
  test("a dead runtime outranks the option failure and empty catalog it causes", () => {
    const notice = resolveHarnessNotice({
      ...healthy,
      runtimeUnavailable: true,
      optionsFailed: true,
      noModels: true,
      configError: "spawn cursor-agent ENOENT",
      savedModelUnavailable: "GPT-5.4 Codex",
      piModelMissing: true,
    })

    expect(notice?.kind).toBe("runtime-unavailable")
    // The runtime's own words still ride along as the detail.
    expect(notice?.detail).toBe("spawn cursor-agent ENOENT")
  })

  test("a runtime failure with no error text still explains itself", () => {
    expect(resolveHarnessNotice({ ...healthy, runtimeUnavailable: true }).detail).toBe(
      "It never finished starting. Retry, or pick another agent.",
    )
  })

  test("failed model discovery is critical and retryable, quoting the runtime verbatim", () => {
    const notice = resolveHarnessNotice({
      ...healthy,
      optionsFailed: true,
      configError: "Cursor SDK requires an explicit cursor-sdk API key.",
    })

    expect(notice).toMatchObject({
      kind: "models-failed",
      tone: "critical",
      message: "Couldn't load Cursor models",
      detail: "Cursor SDK requires an explicit cursor-sdk API key.",
      retry: true,
    })
  })

  test("a provider-catalog error wins over the config error for the detail line", () => {
    expect(
      resolveHarnessNotice({
        ...healthy,
        harnessLabel: "Pi",
        optionsFailed: true,
        providerError: "catalog unavailable",
        configError: "stale",
      })?.detail,
    ).toBe("catalog unavailable")
  })

  test("an error with an empty catalog reports as a load failure even when the list is not stale", () => {
    expect(resolveHarnessNotice({ ...healthy, noModels: true, configError: "ACP connection closed" })?.kind).toBe(
      "models-failed",
    )
  })

  test("an empty catalog with no error at all is not a failure", () => {
    expect(resolveHarnessNotice({ ...healthy, noModels: true })).toBeUndefined()
  })

  test("an unresolvable saved model warns rather than alarms, and offers no retry", () => {
    const notice = resolveHarnessNotice({ ...healthy, savedModelUnavailable: "GPT-5.4 Codex" })

    expect(notice).toMatchObject({
      kind: "saved-model-unavailable",
      tone: "warning",
      message: "GPT-5.4 Codex is unavailable",
      retry: false,
    })
  })

  test("a dropped pi model warns last, behind every harder failure", () => {
    expect(resolveHarnessNotice({ ...healthy, piModelMissing: true })?.kind).toBe("pi-model-missing")
    expect(
      resolveHarnessNotice({ ...healthy, piModelMissing: true, savedModelUnavailable: "GPT-5.4 Codex" })?.kind,
    ).toBe("saved-model-unavailable")
  })
})
