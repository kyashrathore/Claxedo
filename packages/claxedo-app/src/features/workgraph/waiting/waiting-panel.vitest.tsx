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
const recapItem = attention({
  kind: "recap_notification",
  id: "notif_1",
  // @ts-expect-error test fixture
  notification: { id: "notif_1", version: 1 },
  // @ts-expect-error test fixture
  recap: { id: "recap_1", summary: "Idempotency keys shipped in PR #482.", actionableReferences: [{ type: "work_item", id: "i1" }, { type: "attempt", id: "a1" }] },
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
    render(() => body([decisionItem, workItem, recapItem]))
    expect(screen.getByText("Which auth strategy?")).toBeInTheDocument()
    expect(screen.getByText("Backfill invoices")).toBeInTheDocument()
    expect(screen.getByText("Actionable stream recap")).toBeInTheDocument()
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
      setItems([{ ...decisionItem, readAt: 2 }, { ...workItem, readAt: 2 }, recapItem])
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
  test("previews items with one count and leaves management actions to the full panel", () => {
    render(() => <WaitingCard mode="inline" items={[recapItem, decisionItem, workItem]} total={5} unread={3} onClose={() => {}} onSelect={() => {}} />)
    // Lead recap gets the rich treatment.
    expect(screen.getByText("Latest recap")).toBeInTheDocument()
    expect(screen.getByText("Idempotency keys shipped in PR #482.")).toBeInTheDocument()
    expect(screen.getByText("5")).toBeInTheDocument()
    expect(screen.queryByText(/unread/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Open Waiting panel" })).toBeNull()
  })

  // Both card triggers must pair their item with the precise element that fired,
  // so the caller can anchor focus back to it — never discard the invoker.
  test("the lead recap button reports its item and its exact element", async () => {
    const onSelect = vi.fn()
    render(() => <WaitingCard mode="inline" items={[recapItem, decisionItem]} total={2} unread={2} onClose={() => {}} onSelect={onSelect} />)
    const recapButton = screen.getByText("Latest recap").closest("button") as HTMLElement
    await fireEvent.click(recapButton)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0]).toBe(recapItem)
    expect(onSelect.mock.calls[0][1]).toBe(recapButton)
  })

  test("a compact row reports its item and its exact element", async () => {
    const onSelect = vi.fn()
    render(() => <WaitingCard mode="inline" items={[decisionItem, workItem]} total={2} unread={2} onClose={() => {}} onSelect={onSelect} />)
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
        total={1}
        unread={1}
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
        total={1}
        unread={1}
        onClose={() => {}}
        onSelect={() => {}}
        onOpenPanel={() => {}}
      />
    ))
    expect(screen.getByRole("button", { name: /Which auth strategy/ })).toBeInTheDocument()
  })
})
