import type { AttentionItem } from "@claxedo/workgraph/contracts"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createRoot, createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { WaitingCard, createWaitingCardController } from "./waiting-card"
import { WaitingPanelBody, WaitingRow } from "./waiting-panel"
import { toWaitingRow } from "./waiting-source"

afterEach(cleanup)

function attention(partial: Partial<AttentionItem> & Pick<AttentionItem, "kind" | "id">): AttentionItem {
  return { ownerUserId: "user_1", updatedAt: 1, ...partial } as AttentionItem
}

const decisionItem = attention({
  kind: "decision",
  id: "decision_1",
  // @ts-expect-error test fixture is a minimal projection of the record
  record: { id: "decision_1", state: "pending", question: "Which auth strategy?", options: [{ id: "o1", label: "OAuth" }], affectedWorkItemIds: ["i1", "i2"], version: 1 },
})
const workItem = attention({
  kind: "work_item",
  id: "item_1",
  // @ts-expect-error test fixture
  record: { id: "item_1", state: "blocked", title: "Backfill invoices", dependencyIds: ["dep"], version: 1 },
})
const stagedItem = attention({
  kind: "work_item",
  id: "item_pa",
  // @ts-expect-error test fixture
  record: { id: "item_pa", state: "pending_approval", title: "Draft the plan", dependencyIds: [], version: 3, streamId: "stream_1" },
})
type BodyOverrides = Partial<Parameters<typeof WaitingPanelBody>[0]>
function body(items: AttentionItem[], overrides: BodyOverrides = {}) {
  const base = {
    items,
    total: items.length,
    hasMore: false,
    loading: false,
    loaded: true,
    error: undefined as unknown,
    retry: () => {},
    unread: items.length,
    onMarkAllRead: () => {},
    onClear: () => {},
    onSelect: () => {},
  }
  return <WaitingPanelBody {...base} {...overrides} />
}

describe("WaitingPanelBody", () => {
  test("renders a row per attention item with its kind tag", () => {
    render(() => body([decisionItem, workItem]))
    expect(screen.getByText("Which auth strategy?")).toBeInTheDocument()
    expect(screen.getByText("Backfill invoices")).toBeInTheDocument()
    expect(screen.getByText("blocked")).toBeInTheDocument()
  })

  test("selecting a row pairs the underlying attention item with the row's exact element (opens a dialog upstream)", async () => {
    const onSelect = vi.fn()
    render(() => body([decisionItem], { onSelect }))
    const button = screen.getByRole("button", { name: /Which auth strategy/ })
    await fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0]).toBe(decisionItem)
    expect(onSelect.mock.calls[0][1]).toBe(button)
  })

  test("keeps mark-read and clear actions in the full panel", async () => {
    const onMarkAllRead = vi.fn()
    const onClear = vi.fn()
    render(() => body([decisionItem, workItem], { unread: 2, onMarkAllRead, onClear }))
    await fireEvent.click(screen.getByRole("button", { name: "Mark all read" }))
    expect(onMarkAllRead).toHaveBeenCalledOnce()
    await fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    expect(onClear).toHaveBeenCalledOnce()
  })

  test("heads the panel quietly — the list is the count, and unread is not a dot", () => {
    // Same rule the card already follows: the items ARE the signal. Unread still
    // drives Mark all read; it just has no red bead of its own.
    render(() => body([decisionItem, workItem], { unread: 2 }))
    expect(screen.getByText("Needs you")).toBeInTheDocument()
    expect(screen.queryByRole("img", { name: /unread/ })).toBeNull()
    expect(document.querySelector(".workgraph-attention-dot")).toBeNull()
    expect(document.querySelector(".workgraph-count")).toBeNull()
  })

  test("shows an explicit error state with retry — never a snapshot fallback", async () => {
    const retry = vi.fn()
    render(() => body([], { loaded: false, error: new Error("attention unavailable"), retry }))
    expect(screen.getByRole("alert")).toHaveTextContent("attention unavailable")
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(retry).toHaveBeenCalled()
  })

  test("shows a calm empty state at zero attention and a distinct loading state", () => {
    const { unmount } = render(() => body([]))
    expect(screen.getByRole("status")).toHaveTextContent("Nothing needs you right now")
    expect(screen.getByText(/buzz you when that changes/)).toBeInTheDocument()
    unmount()
    render(() => body([], { loading: true, loaded: false }))
    expect(screen.getByRole("status")).toHaveTextContent("Loading")
  })

  test("pages with an explicit Load more control when more items exist", async () => {
    const onLoadMore = vi.fn()
    render(() => body([decisionItem], { total: 4, hasMore: true, onLoadMore }))
    const more = screen.getByRole("button", { name: /Load more \(1 of 4\)/ })
    await fireEvent.click(more)
    expect(onLoadMore).toHaveBeenCalled()
  })
})

describe("WaitingPanelBody — staged approval", () => {
  test("renders staged rows with inline Approve/Reject and a per-stream bulk approve", () => {
    render(() => body([stagedItem], { onApprove: () => {}, onReject: () => {}, onApproveAllStaged: () => {} }))
    expect(screen.getByText("Draft the plan")).toBeInTheDocument()
    // The verb distinguishes staged from result-review.
    expect(screen.getByText("Approve to run")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Approve all staged (1)" })).toBeInTheDocument()
  })

  test("bulk approve hands the caller the stream id and its exact staged items", async () => {
    const onApproveAllStaged = vi.fn()
    render(() => body([stagedItem], { onApprove: () => {}, onReject: () => {}, onApproveAllStaged }))
    await fireEvent.click(screen.getByRole("button", { name: "Approve all staged (1)" }))
    expect(onApproveAllStaged).toHaveBeenCalledTimes(1)
    expect(onApproveAllStaged.mock.calls[0][0]).toBe("stream_1")
    expect(onApproveAllStaged.mock.calls[0][1]).toEqual([stagedItem])
  })

  test("surfaces a partial bulk conflict and flags the conflicted row, which stays staged", () => {
    render(() =>
      body([stagedItem], {
        onApprove: () => {},
        onReject: () => {},
        onApproveAllStaged: () => {},
        bulkResult: { streamId: "stream_1", approved: 4, conflicted: 1 },
        conflictedIds: new Set(["item_pa"]),
      }),
    )
    expect(screen.getByText("4 approved · 1 changed since you looked — re-review")).toBeInTheDocument()
    // The conflicted row is still present (still staged) and visibly flagged.
    expect(screen.getByText("Changed since you looked — re-review")).toBeInTheDocument()
    expect(document.querySelector(".workgraph-waiting-row.is-staged.is-conflicted")).not.toBeNull()
  })

  test("rejecting a staged row demands a reason before it fires", async () => {
    const onReject = vi.fn()
    render(() => body([stagedItem], { onApprove: () => {}, onReject, onApproveAllStaged: () => {} }))
    await fireEvent.click(screen.getByRole("button", { name: "Reject" }))
    const reason = screen.getByRole("textbox", { name: "Reject reason for Draft the plan" })
    // Empty reason cannot submit.
    expect(screen.getByRole("button", { name: "Reject task" })).toBeDisabled()
    await fireEvent.input(reason, { target: { value: "Duplicate" } })
    await fireEvent.click(screen.getByRole("button", { name: "Reject task" }))
    expect(onReject).toHaveBeenCalledWith(stagedItem, "Duplicate")
  })
})

describe("WaitingRow", () => {
  // The shared row backs both the ordinary panel list and the compact contextual
  // card. Each trigger must report its own exact button element via
  // event.currentTarget so the caller can anchor to the precise row that fired.
  test("an ordinary trigger reports its exact invoking element", async () => {
    const onSelect = vi.fn()
    render(() => <WaitingRow view={toWaitingRow(decisionItem)} onSelect={onSelect} />)
    const button = screen.getByRole("button")
    await fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0]).toBe(button)
  })

  test("a compact trigger reports its exact invoking element", async () => {
    const onSelect = vi.fn()
    render(() => <WaitingRow view={toWaitingRow(workItem)} onSelect={onSelect} compact />)
    const button = screen.getByRole("button")
    await fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0]).toBe(button)
  })
})

describe("createWaitingCardController", () => {
  test("derives unread from backend acknowledgements; unpinning is sticky until re-pinned", () => {
    createRoot(() => {
      const [items, setItems] = createSignal<AttentionItem[]>([decisionItem, workItem])
      const controller = createWaitingCardController(items)
      // The pin preference persists module-globally; normalize before asserting.
      controller.reveal(false)
      expect(controller.mode(false)).toBe("inline")
      expect(controller.unread()).toBe(2)
      setItems([{ ...decisionItem, readAt: 2 }, { ...workItem, readAt: 2 }])
      expect(controller.mode(false)).toBe("inline")
      expect(controller.unread()).toBe(0)
      controller.dismiss()
      expect(controller.mode(false)).toBeUndefined()
      // Codex's pinned-summary model: new attention arriving does NOT force
      // the card back — the header control is the only way to re-pin it. The
      // unread state still tracks the new item for the header dot.
      setItems([{ ...decisionItem, readAt: 2 }, { ...workItem, id: "item_2", readAt: undefined, updatedAt: 3 }])
      expect(controller.mode(false)).toBeUndefined()
      expect(controller.unread()).toBe(1)
      controller.reveal(false)
      expect(controller.mode(false)).toBe("inline")
    })
  })

  test("hides for the main panel and floats only when explicitly reopened over that panel state", () => {
    createRoot(() => {
      const controller = createWaitingCardController(() => [decisionItem])
      const firstPanel = {}
      expect(controller.mode(true, firstPanel)).toBeUndefined()
      controller.reveal(true, firstPanel)
      expect(controller.mode(true, firstPanel)).toBe("floating")
      expect(controller.mode(true, {})).toBeUndefined()
      expect(controller.mode(false)).toBe("inline")
    })
  })
})

describe("WaitingCard", () => {
  test("previews items quietly — no count, no unread dot, no management actions", async () => {
    const onOpenPanel = vi.fn()
    render(() => <WaitingCard mode="inline" items={[decisionItem, workItem]} onClose={() => {}} onSelect={() => {}} onOpenPanel={onOpenPanel} />)
    expect(screen.getByText("Which auth strategy?")).toBeInTheDocument()
    // The card IS the signal: no count chip, no unread dot, no extra head icons.
    expect(screen.queryByText(/waiting/)).toBeNull()
    expect(screen.queryByRole("img", { name: /unread/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull()
    // The "Needs you" head row is the way into the full panel.
    await fireEvent.click(screen.getByRole("button", { name: "Needs you" }))
    expect(onOpenPanel).toHaveBeenCalledOnce()
  })

  // Both card triggers must pair their item with the precise element that fired,
  // so the caller can anchor focus back to it — never discard the invoker.
  test("a compact row reports its item and its exact element", async () => {
    const onSelect = vi.fn()
    render(() => <WaitingCard mode="inline" items={[decisionItem, workItem]} onClose={() => {}} onSelect={onSelect} onOpenPanel={() => {}} />)
    const row = screen.getByRole("button", { name: /Backfill invoices/ })
    await fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0]).toBe(workItem)
    expect(onSelect.mock.calls[0][1]).toBe(row)
  })

  test("the inline card folds into the icon rail; floating reveals never collapse", async () => {
    const onOpenPanel = vi.fn()
    const onToggleCollapse = vi.fn()
    const inline = render(() => (
      <WaitingCard
        mode="inline"
        collapsed
        onToggleCollapse={onToggleCollapse}
        items={[decisionItem]}
        onClose={() => {}}
        onSelect={() => {}}
        onOpenPanel={onOpenPanel}
      />
    ))
    // The rail keeps one real control per capability: the full panel + expand.
    await fireEvent.click(screen.getByRole("button", { name: "Open Needs you panel" }))
    expect(onOpenPanel).toHaveBeenCalledOnce()
    await fireEvent.click(screen.getByRole("button", { name: "Expand Needs you" }))
    expect(onToggleCollapse).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button", { name: /Which auth strategy/ })).toBeNull()
    inline.unmount()

    render(() => (
      <WaitingCard
        mode="floating"
        collapsed
        onToggleCollapse={onToggleCollapse}
        items={[decisionItem]}
        onClose={() => {}}
        onSelect={() => {}}
        onOpenPanel={() => {}}
      />
    ))
    expect(screen.getByRole("button", { name: /Which auth strategy/ })).toBeInTheDocument()
  })
})
