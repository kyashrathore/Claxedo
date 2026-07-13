import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createComponent, createSignal } from "solid-js"
import { afterEach, describe, expect, test } from "vitest"
import { createWorkGraphClient } from "./api"
import { workGraphHasAttention } from "./waiting/attention-signal"
import { WorkGraphContent, type WorkGraphPanelBridge } from "./workgraph-content"

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
function mount(request: typeof fetch) {
  const [mode, setMode] = createSignal<"attention" | "settings" | undefined>()
  const header = document.createElement("div")
  const body = document.createElement("div")
  header.dataset.testSlot = "header"
  body.dataset.testSlot = "body"
  document.body.append(header, body)
  const panel: WorkGraphPanelBridge = {
    mode,
    isOpen: () => mode() !== undefined,
    open: (view) => setMode(view),
    close: () => setMode(undefined),
    headerSlot: () => header,
    bodySlot: () => body,
  }
  const { unmount } = render(() => createComponent(WorkGraphContent, { client: createWorkGraphClient({ baseUrl: "http://test.local", request }), panel }))
  return { panel, mode, setMode, header, body, unmount }
}

const streamStat = () => screen.getByText("Needs you", { selector: ".workgraph-stat-label" })

describe("WorkGraph screen", () => {
  test("renders the compact tree and drives 'Needs you' from the Attention endpoint", async () => {
    mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    expect(await screen.findByRole("heading", { name: "Streams" })).toBeInTheDocument()
    expect(await screen.findByText("Ship Claxedo cloud")).toBeInTheDocument()
    // "Needs you" reflects the Attention total (2), not a snapshot-derived count.
    await waitFor(() => expect(streamStat().previousElementSibling).toHaveTextContent("2"))
  })

  test("renders no panel shell of its own — it reuses the shared panel", async () => {
    mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    await screen.findByRole("heading", { name: "Streams" })
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument()
  })

  test("publishes attention to the shared top-level panel toggle signal, clearing it on unmount", async () => {
    const { unmount } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    await waitFor(() => expect(workGraphHasAttention()).toBe(true))
    unmount()
    await waitFor(() => expect(workGraphHasAttention()).toBe(false))
  })

  test("shows the attention dot on the Needs-you control and opens the shared panel with one row per item", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    const needsYou = await screen.findByRole("button", { name: /Needs you — 2 waiting on you/ })
    expect(needsYou.closest(".workgraph-attention-control")?.querySelector(".workgraph-attention-dot")).toBeTruthy()

    await fireEvent.click(needsYou)
    expect(await within(body).findByText("Which auth strategy for the new gateway?")).toBeInTheDocument()
    expect(within(body).getByText("Backfill historical invoices")).toBeInTheDocument()
  })

  test("switches between the Needs you and Settings panel tabs", async () => {
    const { header, body } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    await fireEvent.click(await screen.findByRole("button", { name: /Needs you — 2 waiting on you/ }))
    await within(body).findByText("Which auth strategy for the new gateway?")
    await fireEvent.click(within(header).getByRole("tab", { name: "Settings" }))
    expect(await within(body).findByRole("heading", { name: "WorkGraph settings" })).toBeInTheDocument()
  })

  test("selecting a Waiting row opens a focused dialog over the same screen", async () => {
    const { body } = mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    await fireEvent.click(await screen.findByRole("button", { name: /Needs you — 2 waiting/ }))
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
    expect(within(body).getByText("Execution defaults inherited by every stream, outcome, and task.")).toBeInTheDocument()
  })

  test("a stream row's control icon opens the focused Stream settings dialog", async () => {
    mount(workGraphRequest({ records: () => [stream], attention: () => emptyAttention }))
    await fireEvent.click(await screen.findByRole("button", { name: "Stream settings for Ship Claxedo cloud" }))
    expect(await screen.findByText("Stream settings")).toBeInTheDocument()
  })

  test("the contextual card surfaces unseen attention and hides on dismissal", async () => {
    mount(workGraphRequest({ records: () => [stream], attention: () => attentionPage }))
    const card = await screen.findByRole("dialog", { name: "Waiting on you" })
    expect(card).toBeInTheDocument()
    await fireEvent.click(screen.getByRole("button", { name: "Dismiss waiting card" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Waiting on you" })).not.toBeInTheDocument())
  })
})

// ── Transport stub ──────────────────────────────────────────────────────────

function workGraphRequest(input: {
  records: () => unknown[]
  attention?: () => unknown
  attentionStatus?: number
  command?: (command: Record<string, unknown>) => Record<string, unknown>
}) {
  return (async (request: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(typeof request === "string" ? request : request instanceof URL ? request : request.url).pathname
    if (pathname.endsWith("/changes")) return Response.json({ changes: [], cursor: "cursor_1", timedOut: false })
    if (pathname.includes("/attention")) {
      if (input.attentionStatus) return new Response("nope", { status: input.attentionStatus })
      return Response.json(input.attention?.() ?? emptyAttention)
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
