import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createComponent, createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createWorkGraphClient } from "./api"
import { WorkGraphContent, type WorkGraphPanelBridge } from "./workgraph-content"

// happy-dom leaves window.scrollTo unimplemented; the ChipMenu popover (Kobalte)
// calls it while opening, so shim it to a no-op for the New-stream chip tests.
window.scrollTo = (() => {}) as typeof window.scrollTo

// The route-restorable expanded-Stream set persists to localStorage; reset it so
// each test starts from the first-visit default rather than a prior test's set.
beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  document.querySelectorAll("[data-test-slot]").forEach((node) => node.remove())
})

/**
 * Integration tests for the single WorkGraph screen. WorkGraph owns no panel of
 * its own: it drives the ONE shared WorkspacePanel through an injected bridge
 * and portals its "Needs you" / Settings views into the panel slots. The stubbed
 * transport serves each real endpoint; attention never falls back to the snapshot.
 */
function mount(request: typeof fetch, options?: {
  active?: () => boolean
  mainPanelOpen?: () => boolean
  panelIdentity?: () => unknown
  executionContext?: { kind: "local_worktree"; directory: string }
  localProjects?: readonly { value: string; label: string }[]
  onChooseLocalProject?: () => Promise<string | undefined>
}) {
  const [mode, setMode] = createSignal<"attention" | "settings" | undefined>()
  const header = document.createElement("div")
  const body = document.createElement("div")
  header.dataset.testSlot = "header"
  body.dataset.testSlot = "body"
  document.body.append(header, body)
  const panel: WorkGraphPanelBridge = {
    mode,
    isOpen: () => options?.mainPanelOpen?.() ?? mode() !== undefined,
    identity: () => options?.panelIdentity?.() ?? mode(),
    open: (view) => setMode(view),
    close: () => setMode(undefined),
    headerSlot: () => header,
    bodySlot: () => body,
  }
  const { unmount } = render(() => createComponent(WorkGraphContent, {
    client: createWorkGraphClient({ baseUrl: "http://test.local", request }),
    panel,
    ...options,
  }))
  return { panel, mode, setMode, header, body, unmount }
}

const streamStat = () => screen.getByText("Needs you", { selector: ".workgraph-stat-label" })
const openWaitingPanelFromCard = async () => {
  const card = await screen.findByRole("complementary", { name: "Waiting on you" })
  await fireEvent.click(within(card).getByRole("button", { name: /Which auth strategy/ }))
  await waitFor(() => expect(document.activeElement).toHaveClass("workgraph-waiting-row"))
}

describe("WorkGraph screen", () => {
  test("renders the compact tree and drives 'Needs you' from the Attention endpoint", async () => {
    mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    expect(await screen.findByRole("heading", { name: "Streams" })).toBeInTheDocument()
    expect(await screen.findByText("Ship Claxedo cloud")).toBeInTheDocument()
    // "Needs you" reflects the Attention total (2), not a snapshot-derived count.
    await waitFor(() => expect(streamStat().previousElementSibling).toHaveTextContent("2"))
  })

  test("renders no panel shell of its own — it reuses the shared panel", async () => {
    mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention }))
    await screen.findByRole("heading", { name: "Streams" })
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument()
  })

  test("shows attention inline and opens the matching item in the shared panel", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    const needsYou = await screen.findByRole("button", { name: /Needs you — 2 waiting on you/ })
    expect(needsYou).toHaveAttribute("aria-pressed", "true")
    expect(needsYou.closest(".workgraph-attention-control")?.querySelector(".workgraph-attention-dot")).toBeNull()
    expect(screen.getByRole("complementary", { name: "Waiting on you" })).toHaveClass("is-inline")

    await openWaitingPanelFromCard()
    expect(await within(body).findByText("Which auth strategy for the new gateway?")).toBeInTheDocument()
    expect(within(body).getByText("Backfill historical invoices")).toBeInTheDocument()
    expect(document.activeElement).toBe(within(body).getByRole("button", { name: /Which auth strategy/ }))
  })

  test("hides the inline context for the main panel and floats it when explicitly reopened", async () => {
    const [mainPanelOpen] = createSignal(true)
    const panelIdentity = {}
    mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }), {
      mainPanelOpen,
      panelIdentity: () => panelIdentity,
    })
    const needsYou = await screen.findByRole("button", { name: /Needs you — 2 waiting on you/ })
    expect(screen.queryByRole("complementary", { name: "Waiting on you" })).toBeNull()

    await fireEvent.click(needsYou)
    expect(screen.getByRole("complementary", { name: "Waiting on you" })).toHaveClass("is-floating")
    expect(needsYou).toHaveAttribute("aria-pressed", "true")
  })

  test("toggles the inline context card from its active header control", async () => {
    mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    const needsYou = await screen.findByRole("button", { name: /Needs you — 2 waiting on you/ })
    expect(needsYou).toHaveAttribute("aria-pressed", "true")
    await fireEvent.click(needsYou)
    expect(screen.queryByRole("complementary", { name: "Waiting on you" })).toBeNull()
    expect(needsYou).toHaveAttribute("aria-pressed", "false")
    await fireEvent.click(needsYou)
    expect(screen.getByRole("complementary", { name: "Waiting on you" })).toHaveClass("is-inline")
    expect(needsYou).toHaveAttribute("aria-pressed", "true")
  })

  test("switches between the Needs you and Settings panel tabs", async () => {
    const { header, body } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    await openWaitingPanelFromCard()
    await within(body).findByText("Which auth strategy for the new gateway?")
    await fireEvent.click(within(header).getByRole("tab", { name: "Settings" }))
    expect(await within(body).findByRole("heading", { name: "WorkGraph settings" })).toBeInTheDocument()
  })

  test("renders the inactive Settings tab with a readable text token for sufficient contrast", async () => {
    const { header } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    const settingsTab = await within(header).findByRole("tab", { name: "Settings" })
    // Inactive by default. The muted `text-text-weak` token fails WCAG AA contrast
    // on the panel background at this 12px size; the inactive tab must use the
    // readable base text token instead (it already promotes to it on hover).
    expect(settingsTab).toHaveAttribute("aria-selected", "false")
    expect(settingsTab).toHaveClass("text-text-base")
    expect(settingsTab).not.toHaveClass("text-text-weak")
  })

  test("selecting a Waiting row opens a focused dialog over the same screen", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    await openWaitingPanelFromCard()
    await fireEvent.click(await within(body).findByRole("button", { name: /Which auth strategy/ }))
    // A dialog opens over the same screen; the Streams heading stays mounted, so
    // there is no navigation.
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Streams", hidden: true })).toBeInTheDocument()
  })

  test("never falls back to the snapshot when Attention fails — the panel shows the error, count stays 0", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attentionStatus: 500 }))
    expect(await screen.findByText("Ship Claxedo cloud")).toBeInTheDocument()
    await waitFor(() => expect(streamStat().previousElementSibling).toHaveTextContent("0"))
    await fireEvent.click(screen.getByRole("button", { name: "Needs you" }))
    expect(await within(body).findByRole("alert")).toBeInTheDocument()
    expect(within(body).queryByText("Which auth strategy for the new gateway?")).not.toBeInTheDocument()
  })

  test("the Settings control opens WorkGraph settings inside the shared panel — never a modal", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention }))
    await fireEvent.click(await screen.findByRole("button", { name: "WorkGraph settings" }))
    expect(await within(body).findByRole("heading", { name: "WorkGraph settings" })).toBeInTheDocument()
    expect(within(body).getByText("Default harness, agent, model, effort, and connections used by Streams.")).toBeInTheDocument()
    expect(within(body).queryByLabelText("Environment")).toBeNull()
  })

  test("a stream row's control icon opens Stream settings in the shared panel", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention }))
    await fireEvent.click(await screen.findByRole("button", { name: "Stream settings for Ship Claxedo cloud" }))
    expect(await within(body).findByText("Stream settings")).toBeInTheDocument()
    expect(screen.queryByRole("dialog", { name: "Stream settings" })).toBeNull()
  })

  test("the shared Settings tab returns from Stream settings to WorkGraph settings", async () => {
    const { body, header } = mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention }))
    await fireEvent.click(await screen.findByRole("button", { name: "Stream settings for Ship Claxedo cloud" }))
    expect(await within(body).findByText("Stream settings")).toBeInTheDocument()

    await fireEvent.click(within(header).getByRole("tab", { name: "Settings" }))
    expect(await within(body).findByRole("heading", { name: "WorkGraph settings" })).toBeInTheDocument()
    expect(within(body).queryByText("Stream settings")).toBeNull()
  })

  test("the full Waiting tab owns mark-read and clear actions", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    await openWaitingPanelFromCard()
    await fireEvent.click(within(body).getByRole("button", { name: "Mark all read" }))
    await waitFor(() => expect(within(body).getByRole("button", { name: "Mark all read" })).toBeDisabled())
    await fireEvent.click(within(body).getByRole("button", { name: "Clear" }))
    expect(await within(body).findByText("Nothing needs you right now")).toBeInTheDocument()
  })

  test("keeps backend Attention acknowledgements across an app remount", async () => {
    const request = workGraphRequest({ records: () => [stream], attention: () => attentionPage })
    const first = mount(request)
    await openWaitingPanelFromCard()
    await fireEvent.click(within(first.body).getByRole("button", { name: "Mark all read" }))
    await waitFor(() => expect(within(first.body).getByRole("button", { name: "Mark all read" })).toBeDisabled())
    first.unmount()
    first.header.remove()
    first.body.remove()

    const second = mount(request)
    await openWaitingPanelFromCard()
    expect(within(second.body).getByRole("button", { name: "Mark all read" })).toBeDisabled()
    await fireEvent.click(within(second.body).getByRole("button", { name: "Clear" }))
    expect(await within(second.body).findByText("Nothing needs you right now")).toBeInTheDocument()
    second.unmount()
    second.header.remove()
    second.body.remove()

    const third = mount(request)
    await fireEvent.click(await screen.findByRole("button", { name: "Needs you" }))
    expect(await within(third.body).findByText("Nothing needs you right now")).toBeInTheDocument()
  })

  test("feeds the exact capability catalog into WorkGraph settings so its fields are catalog-derived", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention }))
    await fireEvent.click(await screen.findByRole("button", { name: "WorkGraph settings" }))
    const harness = await within(body).findByRole("combobox", { name: "Harness" })
    expect(within(harness).getByRole("option", { name: "OpenCode" })).toBeInTheDocument()
    expect(within(body).queryByRole("combobox", { name: "Environment" })).toBeNull()
    // The empty defaults are all valid against the catalog, so Save is open.
    expect(within(body).getByRole("button", { name: "Save" })).not.toBeDisabled()
  })

  test("feeds the exact capability catalog into the Stream settings panel", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention }))
    await fireEvent.click(await screen.findByRole("button", { name: "Stream settings for Ship Claxedo cloud" }))
    const environment = await within(body).findByRole("combobox", { name: "Environment" })
    expect(within(environment).getByRole("option", { name: "Local worktree" })).toBeInTheDocument()
  })

  test("stays fail-closed and fabricates no options when the capability catalog returns a 503", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention, capabilitiesStatus: () => 503 }))
    await fireEvent.click(await screen.findByRole("button", { name: "WorkGraph settings" }))
    // The explicit capability failure is surfaced with its real message — never reduced
    // to a generic "no catalog" — and the catalog is never replaced with cached or
    // invented choices, so Save is blocked and no options exist.
    expect(await within(body).findByText("Execution runtime is unavailable.")).toBeInTheDocument()
    expect(within(body).getByRole("button", { name: "Save" })).toBeDisabled()
    expect(within(body).queryByRole("combobox", { name: "Environment" })).not.toBeInTheDocument()
    expect(within(body).queryByRole("option", { name: "Local worktree" })).not.toBeInTheDocument()
  })

  test("refetches the capability catalog when Settings reopens after a failure — no fallback substitute", async () => {
    let failing = true
    const { body, setMode } = mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention, capabilitiesStatus: () => (failing ? 503 : undefined) }))
    await fireEvent.click(await screen.findByRole("button", { name: "WorkGraph settings" }))
    expect(await within(body).findByText("Execution runtime is unavailable.")).toBeInTheDocument()
    // Recover the catalog; the gated resource is refetched when Settings reopens.
    failing = false
    setMode(undefined)
    await waitFor(() => expect(within(body).queryByRole("heading", { name: "WorkGraph settings" })).not.toBeInTheDocument())
    setMode("settings")
    const harness = await within(body).findByRole("combobox", { name: "Harness" })
    expect(within(harness).getByRole("option", { name: "OpenCode" })).toBeInTheDocument()
    expect(within(body).queryByRole("combobox", { name: "Environment" })).toBeNull()
    expect(within(body).getByRole("button", { name: "Save" })).not.toBeDisabled()
  })

  test("derives New-stream override chips from the exact catalog policy — never hardcoded choices", async () => {
    mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention }))
    await screen.findByRole("heading", { name: "Streams" })
    await fireEvent.click(screen.getByRole("button", { name: "New stream" }))

    // The chip menu portals out of the modal dialog, so its options are aria-hidden by
    // Kobalte's focus scope; query them with { hidden: true }. Environment choices are
    // projected from the catalog and every new Stream has an explicit target.
    await fireEvent.click(await screen.findByRole("button", { name: "Local worktree" }))
    await fireEvent.click(await screen.findByText("Cloud workspace"))

    expect(screen.queryByText("Inherit · integration not set")).toBeNull()
  })

  test("creates a local Stream with its required directory and base revision", async () => {
    const commands: Record<string, unknown>[] = []
    mount(
      workGraphRequest({
        records: () => [stream],
        attention: () => emptyAttention,
        command: (command) => {
          commands.push(command)
          return { ok: true, operationId: "op_create", cursor: "c_create", value: { streamId: "stream_new" } }
        },
      }),
      { localProjects: [{ value: "/Users/me/claxedo", label: "Claxedo" }] },
    )
    await screen.findByRole("heading", { name: "Streams" })
    await fireEvent.click(screen.getByRole("button", { name: "New stream" }))
    fireEvent.input(screen.getByPlaceholderText("Stream title"), { target: { value: "Ship stream targets" } })
    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/Users/me/claxedo" },
    })
    fireEvent.input(screen.getByPlaceholderText("HEAD"), { target: { value: "dev" } })
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled())
    await fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toMatchObject({
      type: "create_stream",
      title: "Ship stream targets",
      execution: {
        environment: { kind: "local_worktree", directory: "/Users/me/claxedo" },
        repository: { baseRevision: "dev" },
      },
    })
  })

  test("selects known projects and can add another through the shared project picker", async () => {
    const choose = vi.fn(async () => "/Users/me/new-project")
    mount(
      workGraphRequest({ records: () => [stream], attention: () => emptyAttention }),
      {
        executionContext: { kind: "local_worktree", directory: "/Users/me/claxedo" },
        localProjects: [
          { value: "/Users/me/claxedo", label: "Claxedo" },
          { value: "/Users/me/other", label: "Other" },
        ],
        onChooseLocalProject: choose,
      },
    )
    await screen.findByRole("heading", { name: "Streams" })
    await fireEvent.click(screen.getByRole("button", { name: "New stream" }))

    const project = screen.getByLabelText("Project directory") as HTMLSelectElement
    expect(project.value).toBe("/Users/me/claxedo")
    expect(within(project).getByRole("option", { name: "Other" })).toBeInTheDocument()
    await fireEvent.click(screen.getByRole("button", { name: "Choose another folder…" }))
    await waitFor(() => expect(choose).toHaveBeenCalledOnce())
    await waitFor(() => expect(project.value).toBe("/Users/me/new-project"))
  })

  test("New stream fails closed on capability failure: real banner, no substitute option, retry recovers", async () => {
    let failing = true
    mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention, capabilitiesStatus: () => (failing ? 503 : undefined) }))
    await screen.findByRole("heading", { name: "Streams" })
    await fireEvent.click(screen.getByRole("button", { name: "New stream" }))

    // The exact capability failure is surfaced in the create form. No cached/invented
    // target choice is offered and the Stream cannot be created without a valid target.
    const banner = await screen.findByText("Execution runtime is unavailable.")
    await fireEvent.click(screen.getByRole("button", { name: "Local worktree" }))
    expect(screen.queryAllByRole("button", { name: "Local worktree", hidden: true })).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "Cloud workspace", hidden: true })).toBeNull()
    fireEvent.input(screen.getByPlaceholderText("Stream title"), { target: { value: "Ship it" } })
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled()

    // Retry re-runs the same capability resource; once healthy the chips are catalog-backed.
    failing = false
    await fireEvent.click(within(banner.closest('[role="alert"]') as HTMLElement).getByRole("button", { name: "Reload" }))
    await waitFor(() => expect(screen.queryByText("Execution runtime is unavailable.")).toBeNull())
    expect(await screen.findByText("Cloud workspace")).toBeInTheDocument()
  })

  test("surfaces an ordered change-sync failure through the sync banner and clears it on retry", async () => {
    let failing = true
    mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention, changesStatus: () => (failing ? 500 : undefined) }))
    // The change-sync resource is keyed on the snapshot cursor; its rejection surfaces
    // through the sync StatusBanner rather than an effect writing state.
    const banner = await screen.findByText("Live sync stalled.")
    // Retry re-runs the same sync pass; with the endpoint healthy the banner clears.
    failing = false
    await fireEvent.click(within(banner.closest(".workgraph-toast") as HTMLElement).getByRole("button", { name: "Reload" }))
    await waitFor(() => expect(screen.queryByText("Live sync stalled.")).toBeNull())
  })

  test("holds the change long-poll only while the WorkGraph surface is visible", async () => {
    const [active, setActive] = createSignal(false)
    const signals: AbortSignal[] = []
    mount(
      workGraphRequest({
        records: () => [stream],
        attention: () => emptyAttention,
        onChanges: (signal) => {
          if (signal) signals.push(signal)
        },
      }),
      { active },
    )
    await screen.findByRole("heading", { name: "Streams" })
    expect(signals).toHaveLength(0)

    setActive(true)
    await waitFor(() => expect(signals).toHaveLength(1))
    expect(signals[0]?.aborted).toBe(false)

    setActive(false)
    await waitFor(() => expect(signals[0]?.aborted).toBe(true))
  })

  // ── Focus restoration for attention actions ───────────────────────────────
  // The item that invoked a dialog is remembered exactly; after the dialog acts
  // and attention is refetched, focus lands deterministically on the invoker, the
  // next/previous row, or the panel-tab fallback — never lost to the document.

  test("closing the dialog without resolving restores focus to the exact panel row that opened it", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    await openWaitingPanelFromCard()
    const row = await within(body).findByRole("button", { name: /Which auth strategy/ })
    await fireEvent.click(row)
    await screen.findByRole("dialog")
    await fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(document.activeElement).toBe(row))
  })

  test("resolving an item that leaves Waiting focuses the next attention row in the previous ordering", async () => {
    let items = [attentionPage.items[0], attentionPage.items[1]]
    const { body } = mount(
      workGraphRequest({
        records: () => [stream],
        attention: () => ({ items, total: items.length, hasMore: false }),
        command: (command) => {
          if (command.type === "answer_decision") items = items.filter((item) => item.id !== "decision_1")
          return { ok: true, operationId: "op_1", cursor: "c_2", value: {} }
        },
      }),
    )
    await openWaitingPanelFromCard()
    await fireEvent.click(await within(body).findByRole("button", { name: /Which auth strategy/ }))
    await fireEvent.click(await screen.findByRole("button", { name: /OAuth/ }))
    // The decision left Waiting; focus moves to the row that followed it.
    await waitFor(() => expect(document.activeElement).toBe(within(body).getByRole("button", { name: /Backfill historical invoices/ })))
  })

  test("resolving the last item focuses the previous attention row", async () => {
    // Decision ordered last: with no following row, focus falls to the one before.
    let items = [attentionPage.items[1], attentionPage.items[0]]
    const { body } = mount(
      workGraphRequest({
        records: () => [stream],
        attention: () => ({ items, total: items.length, hasMore: false }),
        command: (command) => {
          if (command.type === "answer_decision") items = items.filter((item) => item.id !== "decision_1")
          return { ok: true, operationId: "op_1", cursor: "c_2", value: {} }
        },
      }),
    )
    await openWaitingPanelFromCard()
    await fireEvent.click(await within(body).findByRole("button", { name: /Which auth strategy/ }))
    await fireEvent.click(await screen.findByRole("button", { name: /OAuth/ }))
    await waitFor(() => expect(document.activeElement).toBe(within(body).getByRole("button", { name: /Backfill historical invoices/ })))
  })

  test("resolving an item that remains focuses its re-rendered row by stable key", async () => {
    // The decision stays in Waiting after the action; its exact invoker is replaced
    // by the re-rendered row, which the same stable key focuses.
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    await openWaitingPanelFromCard()
    await fireEvent.click(await within(body).findByRole("button", { name: /Which auth strategy/ }))
    await fireEvent.click(await screen.findByRole("button", { name: /OAuth/ }))
    await waitFor(() => expect(document.activeElement).toBe(within(body).getByRole("button", { name: /Which auth strategy/ })))
  })

  test("resolving the only item falls back to the Needs you panel tab", async () => {
    let items = [attentionPage.items[0]]
    const { header, body } = mount(
      workGraphRequest({
        records: () => [stream],
        attention: () => ({ items, total: items.length, hasMore: false }),
        command: (command) => {
          if (command.type === "answer_decision") items = []
          return { ok: true, operationId: "op_1", cursor: "c_2", value: {} }
        },
      }),
    )
    await openWaitingPanelFromCard()
    await fireEvent.click(await within(body).findByRole("button", { name: /Which auth strategy/ }))
    await fireEvent.click(await screen.findByRole("button", { name: /OAuth/ }))
    // No row survives, so focus lands on the panel's Needs you tab.
    await waitFor(() => expect(document.activeElement).toBe(within(header).getByRole("tab", { name: /Needs you/ })))
  })
})

// ── Transport stub ──────────────────────────────────────────────────────────

// Faithful bounded /changes long-poll: with no changes to deliver and a positive
// waitMs, hold the request open until the client aborts it (unmount/navigation),
// then answer timedOut — exactly like the server. This makes the synchronizer
// re-issue its next poll instead of tight-looping on an instant empty response.
function holdLongPoll(url: URL, init?: RequestInit): Response | Promise<Response> {
  const after = url.searchParams.get("after") ?? undefined
  const timedOutBody = { changes: [] as unknown[], ...(after ? { cursor: after } : {}), timedOut: true }
  if (Number(url.searchParams.get("waitMs") ?? "0") <= 0) {
    return Response.json({ changes: [], ...(after ? { cursor: after } : {}), timedOut: false })
  }
  const signal = init?.signal
  if (!signal || signal.aborted) return Response.json(timedOutBody)
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(Response.json(timedOutBody)), { once: true }))
}

function workGraphRequest(input: {
  records: () => unknown[]
  attention?: () => unknown
  attentionStatus?: number
  capabilities?: () => unknown
  capabilitiesStatus?: () => number | undefined
  changesStatus?: () => number | undefined
  onChanges?: (signal: AbortSignal | null | undefined) => void
  command?: (command: Record<string, unknown>) => Record<string, unknown>
}) {
  let readAt: number | undefined
  let cleared = false
  return (async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request : request.url)
    const pathname = url.pathname
    if (pathname.endsWith("/changes")) {
      input.onChanges?.(init?.signal)
      const status = input.changesStatus?.()
      if (status) return Response.json({ error: { code: "internal_error", message: "Live sync stalled.", retryable: true } }, { status })
      return holdLongPoll(url, init)
    }
    if (pathname.includes("/execution-capabilities")) {
      const status = input.capabilitiesStatus?.()
      if (status) return Response.json(capabilitiesUnavailable, { status })
      return Response.json(input.capabilities?.() ?? capabilitiesDto)
    }
    if (pathname.includes("/attention")) {
      if (input.attentionStatus) return new Response("nope", { status: input.attentionStatus })
      if (pathname.endsWith("/attention/read")) {
        readAt = 10
        return Response.json({ ownerUserId: "user_1", readAt })
      }
      if (pathname.endsWith("/attention/clear")) {
        readAt = 10
        cleared = true
        return Response.json({ ownerUserId: "user_1", readAt, clearedAt: readAt })
      }
      const page = input.attention?.() ?? emptyAttention
      if (cleared) return Response.json(emptyAttention)
      if (readAt === undefined || typeof page !== "object" || page === null || !("items" in page) || !Array.isArray(page.items)) {
        return Response.json(page)
      }
      return Response.json({ ...page, items: page.items.map((item) => ({ ...item, readAt })) })
    }
    if (pathname.startsWith("/api/workgraph/decisions/") || pathname.includes("/decisions/")) return Response.json(decision)
    if (pathname.endsWith("/defaults")) return Response.json(defaultsDto)
    if (pathname.endsWith("/commands")) {
      const body = JSON.parse(String(init?.body)) as { command: Record<string, unknown> }
      return Response.json(input.command?.(body.command) ?? { ok: true, operationId: "op_1", cursor: "c_2", value: {} })
    }
    const records = input.records() as Array<{ recordType: string; id: string; version: number }>
    return Response.json({
      snapshotCursor: "cursor_1",
      records,
      references: records.map((record, index) => ({ sequence: index + 1, resource: { type: record.recordType, id: record.id }, version: record.version })),
      hasMore: false,
      capturedAt: 2,
    })
  }) as typeof fetch
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const provenance = { actor: { type: "user" as const, id: "user_1" } }
const owner = { schemaVersion: 1 as const, ownerUserId: "user_1", version: 1, createdAt: 1, updatedAt: 5, provenance }

const stream = {
  recordType: "stream" as const,
  ...owner,
  version: 1,
  id: "stream_1",
  title: "Ship Claxedo cloud",
  lifecycleState: "active" as const,
  visibility: "visible" as const,
  pinned: false,
  executionDefaults: {},
  recapDefaults: {},
  activity: { lastActivityAt: 1, recapDueAt: 2 },
  durableEffectCount: 0,
  sourceRevisionRefs: [],
}

const decision = {
  recordType: "decision" as const,
  ...owner,
  version: 4,
  id: "decision_1",
  streamId: "stream_1",
  state: "pending" as const,
  question: "Which auth strategy for the new gateway?",
  options: [
    { id: "o1", label: "OAuth" },
    { id: "o2", label: "SAML" },
  ],
  recommendationOptionId: "o1",
  affectedWorkItemIds: ["item_1", "item_2"],
  sourceRevisionRefs: [],
}

const blockedWorkItem = {
  recordType: "work_item" as const,
  ...owner,
  version: 2,
  id: "item_1",
  streamId: "stream_1",
  title: "Backfill historical invoices",
  state: "blocked" as const,
  priority: 1,
  dependencyIds: ["item_2"],
  sourceRevisionRefs: [],
  completionContract: { version: 1 as const, mode: "all" as const, requirements: [{ id: "req_1", kind: "owner_confirmation" as const, description: "Confirm complete" }] },
  evidenceIds: [],
}

const attentionPage = {
  items: [
    { ownerUserId: "user_1", id: "decision_1", updatedAt: 5, kind: "decision", record: decision },
    { ownerUserId: "user_1", id: "item_1", updatedAt: 5, kind: "work_item", record: blockedWorkItem },
  ],
  total: 2,
  hasMore: false,
}

const emptyAttention = { items: [], total: 0, hasMore: false }

const defaultsDto = {
  recordType: "workgraph",
  schemaVersion: 1,
  ownerUserId: "user_1",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  provenance,
  id: "workgraph_default",
  defaults: { execution: {}, recap: {} },
}

// The enumerable execution capability catalog the settings forms project their
// choices from. Every field option is derived from this — nothing is hardcoded.
const capabilitiesDto = {
  schemaVersion: 1,
  organizationId: "org_1",
  ownerUserId: "user_1",
  catalogRevision: "d".repeat(64),
  observedAt: 5,
  expiresAt: 300_005,
  environments: [
    { kind: "local_worktree", repositoryRequired: false, remoteUrlInput: false, baseRevisionInput: true },
    { kind: "hosted_workspace", repositoryRequired: true, remoteUrlInput: true, baseRevisionInput: true },
  ],
  harnesses: [{ id: "opencode" }],
  agents: [{ harnessId: "opencode", id: "build", label: "Build" }],
  models: [{ harnessId: "opencode", providerId: "anthropic", modelId: "claude-opus-4-8", label: "Opus 4.8", efforts: ["low", "high"] }],
  tools: [{ harnessId: "opencode", id: "bash" }],
  repository: { baseRevisions: ["main", "dev"] },
  connections: [],
}

// The strict 503 capability envelope GET /execution-capabilities returns when the
// catalog cannot be assembled. It must be preserved as an explicit error state,
// never swallowed into cached or fabricated choices.
const capabilitiesUnavailable = {
  error: {
    code: "execution_capabilities_unavailable",
    capability: "runtime",
    reason: "runtime_unavailable",
    message: "Execution runtime is unavailable.",
    retryable: true,
  },
}
