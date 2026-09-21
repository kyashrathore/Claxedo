import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { afterEach, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"
import type { AgentQuestion } from "@claxedo/agent-runtime-contract"
import { SessionQuestionDock } from "./session-question-dock"

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  reply: vi.fn(async (_input: unknown) => undefined),
  reject: vi.fn(async (_input: unknown) => undefined),
}))

vi.mock("@opencode-ai/ui/toast", () => ({ showToast: h.toast }))
vi.mock("@/platform/i18n/provider", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/features/session/app-ports", () => ({
  useSDK: () => ({
    url: "http://localhost:4096",
    directory: "/repo",
    client: { question: { reply: h.reply, reject: h.reject } },
  }),
}))

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

afterEach(() => {
  cleanup()
  localStorage.clear()
  h.toast.mockClear()
  h.reply.mockClear()
  h.reject.mockClear()
})

function request(count: number): AgentQuestion {
  return {
    id: `question-${count}`,
    sessionID: "owner",
    questions: Array.from({ length: count }, (_, i) => ({
      question: `Which option for step ${i + 1}?`,
      header: "Step",
      multiple: false,
      options: [{ label: `Option A${i + 1}` }, { label: `Option B${i + 1}` }],
    })),
  } as AgentQuestion
}

function mount(node: () => JSX.Element) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return render(() => <QueryClientProvider client={client}>{node()}</QueryClientProvider>)
}

test("the collapse control hides the question body and restores it", async () => {
  const view = mount(() => <SessionQuestionDock request={request(1)} onSubmit={() => {}} />)

  await waitFor(() => expect(view.getByRole("radio", { name: /Option A1/ })).toBeTruthy())
  const toggle = view.getByRole("button", { name: "session.question.collapse" })

  fireEvent.click(toggle)

  await waitFor(() => expect(view.queryByRole("radio", { name: /Option A1/ })).toBeNull())
  expect(view.queryByRole("button", { name: "ui.common.submit" })).toBeNull()
  expect(view.container.querySelector('[data-slot="question-header-preview"]')?.textContent).toBe(
    "Which option for step 1?",
  )

  fireEvent.click(view.getByRole("button", { name: "session.question.expand" }))

  await waitFor(() => expect(view.getByRole("radio", { name: /Option A1/ })).toBeTruthy())
  expect(view.getByRole("button", { name: "ui.common.submit" })).toBeTruthy()
  expect(view.container.querySelector('[data-slot="question-header-preview"]')).toBeNull()
})

test("a collapsed dock does not answer on the submit shortcut", async () => {
  const view = mount(() => <SessionQuestionDock request={request(1)} onSubmit={() => {}} />)

  await waitFor(() => expect(view.getByRole("radio", { name: /Option A1/ })).toBeTruthy())
  fireEvent.click(view.getByRole("radio", { name: /Option A1/ }))
  fireEvent.click(view.getByRole("button", { name: "session.question.collapse" }))
  await waitFor(() => expect(view.queryByRole("radio", { name: /Option A1/ })).toBeNull())

  const dock = view.container.querySelector('[data-component="dock-prompt"]')!
  fireEvent.keyDown(dock, { key: "Enter", metaKey: true })
  fireEvent.keyDown(dock, { key: "Escape" })
  // Both replies are mutations, so they reach the client a task later.
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(h.reply).not.toHaveBeenCalled()
  expect(h.reject).not.toHaveBeenCalled()

  fireEvent.click(view.getByRole("button", { name: "session.question.expand" }))
  await waitFor(() => expect(view.getByRole("radio", { name: /Option A1/ })).toBeTruthy())
  fireEvent.keyDown(dock, { key: "Enter", metaKey: true })

  await waitFor(() => expect(h.reply).toHaveBeenCalledWith({ requestID: "question-1", answers: [["Option A1"]] }))
})

test("the progress rail appears only when there is more than one question", async () => {
  const one = mount(() => <SessionQuestionDock request={request(1)} onSubmit={() => {}} />)
  await waitFor(() => expect(one.getByRole("radio", { name: /Option A1/ })).toBeTruthy())
  expect(one.container.querySelectorAll('[data-slot="question-progress-segment"]').length).toBe(0)
  cleanup()

  const two = mount(() => <SessionQuestionDock request={request(2)} onSubmit={() => {}} />)
  await waitFor(() => expect(two.getByRole("radio", { name: /Option A1/ })).toBeTruthy())
  expect(two.container.querySelectorAll('[data-slot="question-progress-segment"]').length).toBe(2)
})


for (const action of ["reply", "reject"] as const) {
  test(`a failed ${action} shows the shared error toast and leaves the answer available for retry`, async () => {
    h[action].mockRejectedValueOnce(new Error("Invalid answer"))
    const view = mount(() => <SessionQuestionDock request={request(1)} onSubmit={() => {}} />)
    await waitFor(() => expect(view.getByRole("radio", { name: /Option A1/ })).toBeTruthy())
    fireEvent.click(view.getByRole("radio", { name: /Option A1/ }))
    const button = view.getByRole("button", { name: action === "reply" ? "ui.common.submit" : "ui.common.dismiss" })
    fireEvent.click(button)
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ title: "common.requestFailed", description: "Invalid answer", variant: "error" }))
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
    expect(view.getByRole("radio", { name: /Option A1/ }).getAttribute("aria-checked")).toBe("true")
    fireEvent.click(button)
    await waitFor(() => expect(h[action]).toHaveBeenCalledTimes(2))
  })
}
