import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createComponent, createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Persist, setPersisted } from "@/platform/persistence/persist"
import type { WorkgraphChangedEvent } from "./workgraph-changed-event"
import { createWorkGraphClient } from "./api"
import type { WorkGraphEventsApi } from "./sync-lifecycle"
import { WorkGraphContent, type WorkGraphPanelBridge } from "./workgraph-content"

// The environment and project-directory chips use the shared Kobalte-backed
// `Select`, which is hard to drive deterministically in happy-dom. Stub it to a
// flat trigger + always-visible option list: the trigger's accessible name is its
// aria-label when provided (project chip) or its current value text otherwise
// (environment chip), and each option carries role="option". The real Select is
// covered by the Playwright e2e; these tests exercise catalog-derivation and the
// create payload through the same props contract.
vi.mock("@opencode-ai/ui/select", () => ({
  Select: (props: {
    options: unknown[]
    current?: unknown
    placeholder?: string
    disabled?: boolean
    label?: (value: unknown) => string
    onSelect?: (value: unknown) => void
    children?: (value: unknown) => unknown
    triggerProps?: Record<string, unknown>
  }) => {
    const display = () => {
      const current = props.current
      if (current === undefined || current === null) return props.placeholder ?? ""
      return props.label ? props.label(current) : String(current)
    }
    return (
      <div data-testid="mock-select">
        <button
          type="button"
          aria-label={props.triggerProps?.["aria-label"] as string | undefined}
          disabled={props.disabled}
        >
          {display()}
        </button>
        <div role="listbox">
          {props.options.map((option) => (
            <div role="option" onClick={() => props.onSelect?.(option)}>
              {props.children ? props.children(option) : props.label ? props.label(option) : String(option)}
            </div>
          ))}
        </div>
      </div>
    )
  },
}))

// Persisted UI state lives in localStorage AND the persistence layer's
// module-level memory cache; `localStorage.clear()` alone does not reset the
// cache, so explicitly write the first-visit defaults back per test.
beforeEach(() => {
  localStorage.clear()
  setPersisted(Persist.global("workgraph.attention-card-pinned.v1"), { pinned: true })
})
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
/**
 * A hand-driven stand-in for the shell's central Claxedo events bus, which the
 * app injects through `features/workgraph/app-ports.ts`. WorkGraph consumes
 * exactly two things from it — the `workgraph.changed` doorbell and the CENTRAL
 * stream's connected state — so the stub is exactly that surface, driven per test.
 */
function testBus(initiallyConnected = true) {
  const handlers = new Set<(event: WorkgraphChangedEvent) => void>()
  const [connected, setConnected] = createSignal(initiallyConnected)
  const api: WorkGraphEventsApi = {
    on: (_type, handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    centralConnected: connected,
  }
  return {
    api,
    setConnected,
    /** Ring the doorbell exactly as the server's coalesced publish would. */
    ring: () => handlers.forEach((handler) => handler({ type: "workgraph.changed", ownerUserId: "user_1", ts: 1 })),
  }
}

function mount(
  request: typeof fetch,
  options?: {
    active?: () => boolean
    events?: WorkGraphEventsApi
    mainPanelOpen?: () => boolean
    panelIdentity?: () => unknown
    executionContext?: { kind: "local_worktree"; placement: "shared"; directory: string }
    localProjects?: readonly { value: string; label: string }[]
    onChooseLocalProject?: () => Promise<string | undefined>
    projectKey?: string
  },
) {
  const [mode, setMode] = createSignal<"attention" | "settings" | "tasks" | undefined>()
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
  const { unmount } = render(() =>
    createComponent(WorkGraphContent, {
      client: createWorkGraphClient({ baseUrl: "http://test.local", request }),
      panel,
      ...options,
    }),
  )
  return { panel, mode, setMode, header, body, unmount }
}

const streamStat = () => screen.getByText("Needs you", { selector: ".workgraph-stat-label" })
// The panel path from the card is its clickable "Needs you" head row — it
// opens the full Waiting list in the shared panel.
const openWaitingPanelFromCard = async () => {
  const card = await screen.findByRole("complementary", { name: "Waiting on you" })
  await fireEvent.click(within(card).getByRole("button", { name: "Needs you" }))
  await waitFor(() =>
    expect(screen.queryAllByRole("button", { name: /Which auth strategy/ }).length).toBeGreaterThan(0),
  )
}

describe("WorkGraph screen", () => {
  test("renders the compact tree and drives 'Needs you' from the Attention endpoint", async () => {
    mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    expect(await screen.findByRole("heading", { name: "Streams" })).toBeInTheDocument()
    expect(await screen.findByText("Ship Claxedo cloud")).toBeInTheDocument()
    // "Needs you" reflects the Attention total (2), not a snapshot-derived count.
    await waitFor(() => expect(streamStat().previousElementSibling).toHaveTextContent("2"))
  })

  test("filters project panes by the canonical app-project key while keeping global attention", async () => {
    const first = {
      ...stream,
      id: "stream_first",
      title: "First project",
      executionDefaults: {
        environment: { kind: "local_worktree" as const, placement: "shared" as const, directory: "/repo/first" },
      },
    }
    const second = {
      ...stream,
      id: "stream_second",
      title: "Second project",
      executionDefaults: {
        environment: { kind: "local_worktree" as const, placement: "shared" as const, directory: "/repo/second" },
      },
    }
    mount(workGraphRequest({ records: () => [first, second], attention: () => attentionPage }), {
      projectKey: "local:/repo/first",
    })

    expect(await screen.findByText("First project")).toBeInTheDocument()
    expect(screen.queryByText("Second project")).toBeNull()
    await waitFor(() => expect(streamStat().previousElementSibling).toHaveTextContent("2"))
  })

  test("renders no panel shell of its own — it reuses the shared panel", async () => {
    mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention }))
    await screen.findByRole("heading", { name: "Streams" })
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument()
  })

  test("shows attention inline and the card's expand action opens the shared panel", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    const needsYou = await screen.findByRole("button", { name: /Needs you — 2 waiting on you/ })
    expect(needsYou).toHaveAttribute("aria-pressed", "true")
    expect(needsYou.closest(".workgraph-attention-control")?.querySelector(".workgraph-attention-dot")).toBeNull()
    expect(screen.getByRole("complementary", { name: "Waiting on you" })).toHaveClass("is-inline")

    await openWaitingPanelFromCard()
    expect(await within(body).findByText("Which auth strategy for the new gateway?")).toBeInTheDocument()
    expect(within(body).getByText("Backfill historical invoices")).toBeInTheDocument()
  })

  test("an expanded card row opens the item's dialog right there — no panel detour", async () => {
    mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    const card = await screen.findByRole("complementary", { name: "Waiting on you" })
    await fireEvent.click(within(card).getByRole("button", { name: /Which auth strategy/ }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    // The shared panel was never opened for this.
    expect(screen.queryByRole("tab", { name: "Needs you" })).toBeNull()
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

  test("the pinned-summary toggle is route-restorable across a reload", async () => {
    const request = workGraphRequest({ records: () => [stream], attention: () => attentionPage })
    const first = mount(request)
    // Unpin from the header control: the card disappears entirely — no rail,
    // no leftover chrome.
    await fireEvent.click(await screen.findByRole("button", { name: /Needs you — 2 waiting on you/ }))
    expect(screen.queryByRole("complementary", { name: "Waiting on you" })).toBeNull()

    // The preference survives a reload…
    first.unmount()
    document.querySelectorAll("[data-test-slot]").forEach((node) => node.remove())
    mount(request)
    await screen.findByText("Ship Claxedo cloud")
    expect(screen.queryByRole("complementary", { name: "Waiting on you" })).toBeNull()

    // …and the header control pins it back.
    await fireEvent.click(screen.getByRole("button", { name: /Needs you — 2 waiting on you/ }))
    expect(await screen.findByRole("complementary", { name: "Waiting on you" })).toBeInTheDocument()
  })

  test("switches between the Needs you and Settings panel tabs", async () => {
    const { header, body } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    await openWaitingPanelFromCard()
    await within(body).findByText("Which auth strategy for the new gateway?")
    await fireEvent.click(within(header).getByRole("tab", { name: "Settings" }))
    expect(await within(body).findByRole("heading", { name: "WorkGraph settings" })).toBeInTheDocument()
  })

  test("a Stream card's More opens the full task list as a Tasks tab in the shared panel", async () => {
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      ...blockedWorkItem,
      id: `item_more_${index + 1}`,
      title: `Ship increment ${index + 1}`,
      state: "pending" as const,
      dependencyIds: [],
    }))
    const { header, body, mode } = mount(
      workGraphRequest({ records: () => [stream, ...tasks], attention: () => emptyAttention }),
    )

    // The card previews only the first few tasks; the rest sit behind More. No
    // Tasks tab exists until a Stream's full list is requested.
    expect(await screen.findByText("Ship increment 1")).toBeInTheDocument()
    expect(screen.queryByText("Ship increment 5")).not.toBeInTheDocument()
    expect(within(header).queryByRole("tab", { name: "Tasks" })).toBeNull()

    await fireEvent.click(screen.getByRole("button", { name: "All tasks for Ship Claxedo cloud" }))
    expect(mode()).toBe("tasks")
    expect(await within(header).findByRole("tab", { name: "Tasks" })).toHaveAttribute("aria-selected", "true")
    // The panel body lists every task of the Stream, including the hidden tail.
    expect(await within(body).findByText("Ship increment 5")).toBeInTheDocument()
    expect(within(body).getByText("Ship increment 1")).toBeInTheDocument()
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
    expect(
      within(body).getByText("Default harness, agent, model, effort, and connections used by Streams."),
    ).toBeInTheDocument()
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
    const { body } = mount(
      workGraphRequest({ records: () => [stream], attention: () => emptyAttention, capabilitiesStatus: () => 503 }),
    )
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
    const { body, setMode } = mount(
      workGraphRequest({
        records: () => [stream],
        attention: () => emptyAttention,
        capabilitiesStatus: () => (failing ? 503 : undefined),
      }),
    )
    await fireEvent.click(await screen.findByRole("button", { name: "WorkGraph settings" }))
    expect(await within(body).findByText("Execution runtime is unavailable.")).toBeInTheDocument()
    // Recover the catalog; the gated resource is refetched when Settings reopens.
    failing = false
    setMode(undefined)
    await waitFor(() =>
      expect(within(body).queryByRole("heading", { name: "WorkGraph settings" })).not.toBeInTheDocument(),
    )
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

    // The environment chip's options are projected from the catalog: switching it to
    // the Cloud workspace target is only possible because the catalog advertises it.
    await fireEvent.click(await screen.findByRole("button", { name: "Local worktree" }))
    await fireEvent.click(await screen.findByRole("option", { name: "Cloud workspace" }))

    expect(screen.queryByText("Inherit · integration not set")).toBeNull()
    // The chip now reflects the catalog-derived selection.
    expect(await screen.findByRole("button", { name: "Cloud workspace" })).toBeInTheDocument()
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
    // The project-directory chip lists known projects by basename; pick the target.
    await fireEvent.click(screen.getByRole("option", { name: "claxedo" }))
    // The base-revision chip opens a popover whose text field accepts any raw ref;
    // Enter commits the typed value even when it matches no advertised revision. The
    // popover portals outside the modal dialog, so Kobalte's focus scope marks it
    // aria-hidden — query it with { hidden: true }.
    await fireEvent.click(screen.getByRole("button", { name: "Base revision" }))
    const revision = await screen.findByRole("textbox", { name: "Base revision", hidden: true })
    fireEvent.input(revision, { target: { value: "dev" } })
    fireEvent.keyDown(revision, { key: "Enter" })
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled())
    await fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toMatchObject({
      type: "create_stream",
      title: "Ship stream targets",
      execution: {
        environment: { kind: "local_worktree", placement: "shared", directory: "/Users/me/claxedo" },
        repository: { baseRevision: "dev" },
      },
    })
  })

  test("promotes a child Stream only after confirming its parent budget carve", async () => {
    const commands: Record<string, unknown>[] = []
    const parent = {
      ...stream,
      executionDefaults: {
        environment: { kind: "local_worktree" as const, placement: "shared" as const, directory: "/Users/me/claxedo" },
        repository: { baseRevision: "dev" },
        autonomy: "autonomous" as const,
        budget: { amount: 50_000, unit: "tokens" as const, window: "stream" as const },
        mayPromote: true,
      },
    }
    mount(
      workGraphRequest({
        records: () => [parent],
        attention: () => emptyAttention,
        command: (command) => {
          commands.push(command)
          return { ok: true, operationId: "op_promote", cursor: "c_promote", value: { streamId: "stream_child" } }
        },
      }),
    )
    await screen.findByRole("heading", { name: "Streams" })

    await fireEvent.click(await screen.findByRole("button", { name: "Promote child from Ship Claxedo cloud" }))
    fireEvent.input(screen.getByPlaceholderText("Stream title"), { target: { value: "Extract billing engine" } })
    fireEvent.input(screen.getByLabelText("Budget carve"), { target: { value: "15000" } })
    await waitFor(() => expect(screen.getByRole("button", { name: "Review promotion" })).not.toBeDisabled())
    await fireEvent.click(screen.getByRole("button", { name: "Review promotion" }))

    expect(await screen.findByRole("heading", { name: "Confirm child Stream promotion" })).toBeInTheDocument()
    expect(commands).toHaveLength(0)
    await fireEvent.click(screen.getByRole("button", { name: "Confirm promotion" }))

    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toMatchObject({
      type: "create_stream",
      title: "Extract billing engine",
      parentStreamId: "stream_1",
      budgetCarve: { amount: 15_000, unit: "tokens", window: "stream" },
      confirmAutonomy: true,
      execution: {
        environment: { kind: "local_worktree", placement: "shared", directory: "/Users/me/claxedo" },
        repository: { baseRevision: "dev" },
      },
    })
  })

  test("refetches directory-scoped base revisions when the project chip changes", async () => {
    const requestedDirectories: (string | undefined)[] = []
    mount(
      workGraphRequest({
        records: () => [stream],
        attention: () => emptyAttention,
        onCapabilities: (directory) => requestedDirectories.push(directory),
        // Each project advertises its own local branches; the Base revision popover
        // must list the branches of whichever directory is currently selected.
        capabilitiesFor: (directory) => ({
          ...capabilitiesDto,
          repository: {
            baseRevisions:
              directory === "/Users/me/claxedo"
                ? ["main", "claxedo-feature"]
                : directory === "/Users/me/other"
                  ? ["main", "other-feature"]
                  : ["main", "dev"],
          },
        }),
      }),
      {
        localProjects: [
          { value: "/Users/me/claxedo", label: "Claxedo" },
          { value: "/Users/me/other", label: "Other" },
        ],
      },
    )
    await screen.findByRole("heading", { name: "Streams" })
    await fireEvent.click(screen.getByRole("button", { name: "New stream" }))

    // Selecting the first project scopes discovery to its directory and lists its
    // branches in the Base revision popover (revisions render as list buttons that
    // the portalled popover marks aria-hidden under the dialog's focus scope).
    await fireEvent.click(screen.getByRole("option", { name: "claxedo" }))
    await waitFor(() => expect(requestedDirectories).toContain("/Users/me/claxedo"))
    await fireEvent.click(screen.getByRole("button", { name: "Base revision" }))
    expect(await screen.findByRole("button", { name: "claxedo-feature", hidden: true })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "other-feature", hidden: true })).toBeNull()
    // Toggle the popover closed via its trigger (Escape would dismiss the whole
    // create dialog) before switching projects.
    await fireEvent.click(screen.getByRole("button", { name: "Base revision" }))

    // Switching to the other project refetches for THAT directory and swaps the list.
    await fireEvent.click(screen.getByRole("option", { name: "other" }))
    await waitFor(() => expect(requestedDirectories).toContain("/Users/me/other"))
    await fireEvent.click(screen.getByRole("button", { name: "Base revision" }))
    expect(await screen.findByRole("button", { name: "other-feature", hidden: true })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "claxedo-feature", hidden: true })).toBeNull()
  })

  test("selects known projects and can add another through the shared project picker", async () => {
    const choose = vi.fn(async () => "/Users/me/new-project")
    mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention }), {
      executionContext: { kind: "local_worktree", directory: "/Users/me/claxedo" },
      localProjects: [
        { value: "/Users/me/claxedo", label: "Claxedo" },
        { value: "/Users/me/other", label: "Other" },
      ],
      onChooseLocalProject: choose,
    })
    await screen.findByRole("heading", { name: "Streams" })
    await fireEvent.click(screen.getByRole("button", { name: "New stream" }))

    // The chip shows the seeded project by basename and lists the other known
    // projects the same way; the final entry re-opens the shared folder picker.
    const project = screen.getByLabelText("Project directory")
    expect(project).toHaveTextContent("claxedo")
    expect(screen.getByRole("option", { name: "other" })).toBeInTheDocument()
    await fireEvent.click(screen.getByRole("option", { name: "Choose another folder…" }))
    await waitFor(() => expect(choose).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByLabelText("Project directory")).toHaveTextContent("new-project"))
  })

  test("offers no base revision until a project is chosen, and gates Create on choosing one", async () => {
    mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention }), {
      localProjects: [{ value: "/Users/me/formlink", label: "formlink" }],
    })
    await screen.findByRole("heading", { name: "Streams" })
    await fireEvent.click(screen.getByRole("button", { name: "New stream" }))
    fireEvent.input(screen.getByPlaceholderText("Stream title"), { target: { value: "Ship it" } })

    // With no project selected there is no repository to enumerate refs from: the
    // chip is absent rather than showing some other repository's branches (the
    // WorkGraph ledger's, in the local server's case), and Create stays disabled.
    expect(screen.queryByRole("button", { name: "Base revision" })).toBeNull()
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled()

    // Choosing the project is what makes revisions meaningful — and available.
    await fireEvent.click(screen.getByRole("option", { name: "formlink" }))
    expect(await screen.findByRole("button", { name: "Base revision" })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled())
  })

  test("New stream fails closed on capability failure: real banner, no substitute option, retry recovers", async () => {
    let failing = true
    mount(
      workGraphRequest({
        records: () => [stream],
        attention: () => emptyAttention,
        capabilitiesStatus: () => (failing ? 503 : undefined),
      }),
    )
    await screen.findByRole("heading", { name: "Streams" })
    await fireEvent.click(screen.getByRole("button", { name: "New stream" }))

    // The exact capability failure is surfaced in the create form. No cached/invented
    // target choice is offered and the Stream cannot be created without a valid target.
    const banner = await screen.findByText("Execution runtime is unavailable.")
    // The environment chip trigger stays, but the unavailable catalog offers it no
    // options — no substitute Local worktree / Cloud workspace choice is fabricated.
    expect(screen.queryAllByRole("button", { name: "Local worktree" })).toHaveLength(1)
    expect(screen.queryByRole("option", { name: "Local worktree" })).toBeNull()
    expect(screen.queryByRole("option", { name: "Cloud workspace" })).toBeNull()
    fireEvent.input(screen.getByPlaceholderText("Stream title"), { target: { value: "Ship it" } })
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled()

    // Retry re-runs the same capability resource; once healthy the chips are catalog-backed.
    failing = false
    await fireEvent.click(
      within(banner.closest('[role="alert"]') as HTMLElement).getByRole("button", { name: "Reload" }),
    )
    await waitFor(() => expect(screen.queryByText("Execution runtime is unavailable.")).toBeNull())
    expect(await screen.findByRole("option", { name: "Cloud workspace" })).toBeInTheDocument()
  })

  // ── Live sync: doorbell + revalidate ──────────────────────────────────────
  // WorkGraph holds ZERO sockets of its own. The server rings `workgraph.changed`
  // on the already-open central events stream and the surface re-reads the
  // canonical snapshot + Attention; the cursored `/changes` long-poll is gone.

  test("re-reads the canonical snapshot when the server rings the workgraph.changed doorbell", async () => {
    const bus = testBus()
    let snapshots = 0
    let title = "Ship Claxedo cloud"
    mount(
      workGraphRequest({
        records: () => [{ ...stream, title }],
        attention: () => emptyAttention,
        onSnapshot: () => snapshots++,
      }),
      { events: bus.api },
    )
    await screen.findByText("Ship Claxedo cloud")
    expect(snapshots).toBe(1)

    // A remote mutation (an agent, another tab, an MCP tool) rings the doorbell —
    // the board picks the change up without ever polling for it.
    title = "Ship Claxedo cloud v2"
    bus.ring()
    expect(await screen.findByText("Ship Claxedo cloud v2")).toBeInTheDocument()
  })

  test("issues no /changes request at all — the poll is gone, not shortened", async () => {
    const bus = testBus()
    const paths: string[] = []
    const request = workGraphRequest({ records: () => [stream], attention: () => emptyAttention })
    mount(
      ((input: string | URL | Request, init?: RequestInit) => {
        paths.push(new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname)
        return request(input, init)
      }) as typeof fetch,
      { events: bus.api },
    )
    await screen.findByRole("heading", { name: "Streams" })
    bus.ring()
    await waitFor(() => expect(paths.filter((path) => path.endsWith("/snapshot")).length).toBeGreaterThan(1))
    expect(paths.filter((path) => path.includes("/changes"))).toEqual([])
  })

  test("folds a burst of doorbell nudges into a single canonical reload", async () => {
    const bus = testBus()
    let snapshots = 0
    mount(
      workGraphRequest({ records: () => [stream], attention: () => emptyAttention, onSnapshot: () => snapshots++ }),
      { events: bus.api },
    )
    await screen.findByRole("heading", { name: "Streams" })
    await waitFor(() => expect(snapshots).toBe(1))

    // Two nudges for one logical burst are expected (a command and the reconciler
    // tick can both fire); the trailing debounce makes the reload idempotent.
    bus.ring()
    bus.ring()
    bus.ring()
    await waitFor(() => expect(snapshots).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(snapshots).toBe(2)
  })

  test("surfaces a failed doorbell reload through the sync banner and clears it on retry", async () => {
    const bus = testBus()
    let failing = false
    mount(
      workGraphRequest({
        records: () => [stream],
        attention: () => emptyAttention,
        snapshotStatus: () => (failing ? 500 : undefined),
      }),
      { events: bus.api },
    )
    await screen.findByRole("heading", { name: "Streams" })

    // R4 — never SILENTLY stale: a revalidation that fails stalls the surface and
    // surfaces the error verbatim rather than sitting on data of unknown currency.
    failing = true
    bus.ring()
    const toast = await waitFor(() => {
      const node = document.querySelector(".workgraph-toast")
      expect(node?.textContent).toContain("Live sync stalled.")
      return node as HTMLElement
    })

    // Retry re-runs exactly that reload — the only way out of the stall; a further
    // doorbell nudge must NOT quietly paper over it.
    failing = false
    await fireEvent.click(within(toast).getByRole("button", { name: "Reload" }))
    await waitFor(() => expect(document.querySelector(".workgraph-toast")).toBeNull())
  })

  test("revalidates once when the surface becomes active again — no cursor, no diff", async () => {
    const [active, setActive] = createSignal(false)
    const bus = testBus()
    let snapshots = 0
    mount(
      workGraphRequest({ records: () => [stream], attention: () => emptyAttention, onSnapshot: () => snapshots++ }),
      { active, events: bus.api },
    )
    await screen.findByRole("heading", { name: "Streams" })
    await waitFor(() => expect(snapshots).toBe(1))

    // While the surface is not the route the user is looking at, nudges are ignored
    // — the reload it skipped is earned back on activation instead.
    bus.ring()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(snapshots).toBe(1)

    setActive(true)
    await waitFor(() => expect(snapshots).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(snapshots).toBe(2)
  })

  test("revalidates once when the events stream reconnects — a nudge lost in the gap cannot leave the board stale", async () => {
    const bus = testBus(false)
    let snapshots = 0
    mount(
      workGraphRequest({ records: () => [stream], attention: () => emptyAttention, onSnapshot: () => snapshots++ }),
      { events: bus.api },
    )
    await screen.findByRole("heading", { name: "Streams" })
    await waitFor(() => expect(snapshots).toBe(1))

    bus.setConnected(true)
    await waitFor(() => expect(snapshots).toBe(2))
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
    await waitFor(() =>
      expect(document.activeElement).toBe(within(body).getByRole("button", { name: /Backfill historical invoices/ })),
    )
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
    await waitFor(() =>
      expect(document.activeElement).toBe(within(body).getByRole("button", { name: /Backfill historical invoices/ })),
    )
  })

  test("resolving an item that remains focuses its re-rendered row by stable key", async () => {
    // The decision stays in Waiting after the action; its exact invoker is replaced
    // by the re-rendered row, which the same stable key focuses.
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    await openWaitingPanelFromCard()
    await fireEvent.click(await within(body).findByRole("button", { name: /Which auth strategy/ }))
    await fireEvent.click(await screen.findByRole("button", { name: /OAuth/ }))
    await waitFor(() =>
      expect(document.activeElement).toBe(within(body).getByRole("button", { name: /Which auth strategy/ })),
    )
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

function workGraphRequest(input: {
  records: () => unknown[]
  attention?: () => unknown
  attentionStatus?: number
  capabilities?: () => unknown
  capabilitiesFor?: (directory: string | undefined) => unknown
  onCapabilities?: (directory: string | undefined) => void
  capabilitiesStatus?: () => number | undefined
  snapshotStatus?: () => number | undefined
  onSnapshot?: () => void
  command?: (command: Record<string, unknown>) => Record<string, unknown>
}) {
  let readAt: number | undefined
  let cleared = false
  return (async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request : request.url)
    const pathname = url.pathname
    if (pathname.includes("/execution-capabilities")) {
      const status = input.capabilitiesStatus?.()
      if (status) return Response.json(capabilitiesUnavailable, { status })
      const directory = url.searchParams.get("directory") ?? undefined
      input.onCapabilities?.(directory)
      return Response.json(input.capabilitiesFor?.(directory) ?? input.capabilities?.() ?? capabilitiesDto)
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
      if (
        readAt === undefined ||
        typeof page !== "object" ||
        page === null ||
        !("items" in page) ||
        !Array.isArray(page.items)
      ) {
        return Response.json(page)
      }
      return Response.json({ ...page, items: page.items.map((item) => ({ ...item, readAt })) })
    }
    if (pathname.startsWith("/api/workgraph/decisions/") || pathname.includes("/decisions/"))
      return Response.json(decision)
    if (pathname.endsWith("/defaults")) return Response.json(defaultsDto)
    if (pathname.endsWith("/commands")) {
      const body = JSON.parse(String(init?.body)) as { command: Record<string, unknown> }
      return Response.json(input.command?.(body.command) ?? { ok: true, operationId: "op_1", cursor: "c_2", value: {} })
    }
    input.onSnapshot?.()
    const snapshotStatus = input.snapshotStatus?.()
    if (snapshotStatus) {
      return Response.json(
        { error: { code: "internal_error", message: "Live sync stalled.", retryable: true } },
        { status: snapshotStatus },
      )
    }
    const records = input.records() as Array<{ recordType: string; id: string; version: number }>
    return Response.json({
      snapshotCursor: "cursor_1",
      records,
      references: records.map((record, index) => ({
        sequence: index + 1,
        resource: { type: record.recordType, id: record.id },
        version: record.version,
      })),
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
  activity: { lastActivityAt: 1 },
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
  completionContract: {
    version: 1 as const,
    mode: "all" as const,
    requirements: [{ id: "req_1", kind: "owner_confirmation" as const, description: "Confirm complete" }],
  },
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
  defaults: { execution: {} },
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
  models: [
    {
      harnessId: "opencode",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      label: "Opus 4.8",
      efforts: ["low", "high"],
    },
  ],
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
