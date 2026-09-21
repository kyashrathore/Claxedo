import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { SessionPermissionDock } from "./session-permission-dock"
import { createRoot, createSignal, Show } from "solid-js"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { createSessionComposerState } from "./session-composer-state"

const fixtures = vi.hoisted(() => ({
  permission: { id: "perm-double", sessionID: "session", permission: "execute", patterns: [], always: [], metadata: {} },
  respond: vi.fn(), toast: vi.fn(), requests: vi.fn(), questions: vi.fn(),
}))
vi.mock("@tanstack/solid-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/solid-query")>(),
  useQuery: () => ({ data: undefined }),
  useQueries: (options: () => { queries: { queryKey: readonly unknown[] }[] }) => [{ get data() { const id = options().queries[0]?.queryKey[2]; return { permissions: fixtures.requests().filter((item: { sessionID: string }) => item.sessionID === id), questions: fixtures.questions().filter((item: { sessionID: string }) => item.sessionID === id) } } }],
}))
vi.mock("@/features/session/providers/session-params", () => ({ useSessionParams: () => ({ sessionId: () => "session" }) }))
vi.mock("@/features/session/app-ports", () => ({ useSDK: () => ({ directory: "/work" }) }))
vi.mock("@/platform/i18n/provider", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: fixtures.toast }))
vi.mock("@/platform/telemetry/analytics", () => ({ capture: vi.fn(), identityProps: () => ({}) }))
vi.mock("@/features/session/providers/permission", () => ({ usePermission: () => ({
  observeDirectory: () => () => {}, requestPolicyReady: () => true, autoResponds: () => false, respond: fixtures.respond,
}) }))
let dispose = () => {}
beforeEach(() => { fixtures.requests.mockImplementation(() => [fixtures.permission]); fixtures.questions.mockReturnValue([]) })
afterEach(() => { cleanup(); dispose(); queryClient.clear(); vi.clearAllMocks() })
const mount = () => createRoot((cleanup) => { dispose = cleanup; return createSessionComposerState() })

test("locks a decision synchronously and keeps it locked until the acknowledged request leaves the query", async () => {
  let finish!: () => void
  fixtures.respond.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  const state = mount()
  state.decide("always")
  state.decide("always")
  expect(fixtures.respond).toHaveBeenCalledTimes(1)
  expect(state.permissionResponding()).toBe(true)
  finish()
  await Promise.resolve()
  await Promise.resolve()
  state.decide("once")
  expect(fixtures.respond).toHaveBeenCalledTimes(1)
  expect(state.permissionResponding()).toBe(true)
})

test("a failed decision unlocks the same request for retry", async () => {
  fixtures.respond.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined)
  const state = mount()
  state.decide("once")
  await Promise.resolve()
  await Promise.resolve()
  expect(state.permissionResponding()).toBe(false)
  expect(fixtures.toast).toHaveBeenCalledTimes(1)
  state.decide("reject")
  expect(fixtures.respond).toHaveBeenCalledTimes(2)
})

test("a dock click disables every decision immediately and canonical removal dismisses it", async () => {
  const [requests, setRequests] = createSignal([fixtures.permission])
  fixtures.requests.mockImplementation(requests)
  let acknowledge!: () => void
  fixtures.respond.mockImplementation(() => new Promise<void>((resolve) => {
    acknowledge = () => { setRequests([]); resolve() }
  }))
  const view = render(() => {
    const state = createSessionComposerState()
    return <Show when={state.permissionRequest()}>{(request) => <SessionPermissionDock request={request()} responding={state.permissionResponding()} onDecide={state.decide} />}</Show>
  })
  const allow = view.getByRole<HTMLButtonElement>("button", { name: "ui.permission.allowAlways" })
  fireEvent.click(allow)
  expect(allow.disabled).toBe(true)
  fireEvent.click(allow)
  expect(fixtures.respond).toHaveBeenCalledTimes(1)
  acknowledge()
  await waitFor(() => expect(view.queryByRole("button", { name: "ui.permission.allowAlways" })).toBeNull())
})


test("a pending start question is visible only while its owning draft is selected", async () => {
  const question = { id: "start-question", sessionID: "reserved", questions: [] }
  fixtures.questions.mockReturnValue([question])
  const [pending, setPending] = createSignal<string | undefined>("reserved")
  const state = createRoot((cleanup) => { dispose = cleanup; return createSessionComposerState({ pendingSessionId: pending }) })
  expect(state.questionRequest()).toEqual(question)
  setPending(undefined)
  expect(state.questionRequest()).toBeUndefined()
})


test("a status refresh for the same pending session does not restart request attachment quarantine", () => {
  const question = { id: "stable-question", sessionID: "reserved", questions: [] }
  fixtures.questions.mockReturnValue([question])
  const [revision, refresh] = createSignal(1)
  const state = createRoot((cleanup) => { dispose = cleanup; return createSessionComposerState({ pendingSessionId: () => { revision(); return "reserved" } }) })
  expect(state.questionRequest()).toEqual(question)
  queryClient.setQueryData(shellDataKeys.sessionId("reserved", "requests"), { permissions: [], questions: [question] })
  refresh(2)
  expect(state.questionRequest()).toEqual(question)
})
