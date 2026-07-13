import type { AttentionItem } from "@claxedo/workgraph/contracts"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createRoot, createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { WaitingCard, createWaitingCardController } from "./waiting-card"
import { WaitingPanelBody } from "./waiting-panel"

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

  test("selecting a row reports the underlying attention item (opens a dialog upstream)", async () => {
    const onSelect = vi.fn()
    render(() => body([decisionItem], { onSelect }))
    await fireEvent.click(screen.getByRole("button", { name: /Which auth strategy/ }))
    expect(onSelect).toHaveBeenCalledWith(decisionItem)
  })

  test("shows an explicit error state with retry — never a snapshot fallback", async () => {
    const retry = vi.fn()
    render(() => body([], { loaded: false, error: new Error("attention unavailable"), retry }))
    expect(screen.getByRole("alert")).toHaveTextContent("attention unavailable")
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(retry).toHaveBeenCalled()
  })

  test("contributes no body at zero attention, but still shows a distinct loading state", () => {
    // A successful load with zero items renders absolutely nothing — no intro, dot,
    // list, or "Nothing is waiting on you" placeholder.
    const { container, unmount } = render(() => body([]))
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText("Nothing is waiting on you.")).not.toBeInTheDocument()
    expect(container.querySelector(".workgraph-waiting-intro")).toBeNull()
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

describe("createWaitingCardController", () => {
  test("hides after dismissal and reappears only for newly unseen attention", () => {
    createRoot(() => {
      const [items, setItems] = createSignal<AttentionItem[]>([decisionItem, workItem])
      const controller = createWaitingCardController(items)
      expect(controller.visible(false)).toBe(true)
      // Dismiss: no longer visible for the same items…
      controller.markAllSeen()
      expect(controller.visible(false)).toBe(false)
      // …and stays hidden even as the same items persist.
      setItems([decisionItem, workItem])
      expect(controller.visible(false)).toBe(false)
      // New attention makes it reappear.
      setItems([decisionItem, workItem, recapItem])
      expect(controller.visible(false)).toBe(true)
    })
  })

  test("is never visible while the panel is open", () => {
    createRoot(() => {
      const controller = createWaitingCardController(() => [decisionItem])
      expect(controller.visible(true)).toBe(false)
    })
  })
})

describe("WaitingCard", () => {
  test("previews items, exposes dismiss and open-panel affordances", async () => {
    const onDismiss = vi.fn()
    const onOpen = vi.fn()
    render(() => <WaitingCard items={[recapItem, decisionItem, workItem]} total={5} working={1} onOpenPanel={onOpen} onDismiss={onDismiss} onSelect={() => {}} />)
    // Lead recap gets the rich treatment.
    expect(screen.getByText("Latest recap")).toBeInTheDocument()
    expect(screen.getByText("Idempotency keys shipped in PR #482.")).toBeInTheDocument()
    expect(screen.getByText("1 working")).toBeInTheDocument()
    await fireEvent.click(screen.getByRole("button", { name: "Open Waiting panel" }))
    expect(onOpen).toHaveBeenCalled()
    await fireEvent.click(screen.getByRole("button", { name: "Dismiss waiting card" }))
    expect(onDismiss).toHaveBeenCalled()
  })
})
