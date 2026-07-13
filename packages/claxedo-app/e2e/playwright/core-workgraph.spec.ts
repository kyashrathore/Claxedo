/**
 * Canonical WorkGraph browser contract.
 *
 * Every test owns a fresh file-backed SQLite database and the real embedded
 * WorkGraph HTTP router. Playwright never intercepts a route, and fixture setup
 * uses only public commands plus the same source-planning and Recap background
 * runtimes used by the product.
 */
import { expect, test, type APIRequestContext } from "@playwright/test"
import type { CommandResult, WorkGraphCommandRequest } from "@claxedo/workgraph/contracts"
import fs from "node:fs"
import path from "node:path"
import { createRealWorkGraphHarness, type RealWorkGraphHarness } from "../helpers/real-workgraph-harness"

const apiPort = Number(process.env.CLAXEDO_WORKGRAPH_E2E_API_PORT ?? 4311)
let harness: RealWorkGraphHarness

test.describe.serial("@core personal WorkGraph real local journey", () => {
  test.beforeEach(async () => {
    harness = await createRealWorkGraphHarness({ port: apiPort })
  })

  test.afterEach(async () => {
    await harness.close()
  })

  test("uses one WorkspacePanel and supports manual streams, tasks, and tabless settings", async ({ page, request }) => {
    await page.goto("/workgraph")
    await expect(page.getByRole("main", { name: "WorkGraph" })).toBeVisible()

    await page.getByRole("button", { name: "Needs you", exact: true }).click()
    const panel = page.getByRole("complementary", { name: "Workspace panel" })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole("tab", { name: "Needs you" })).toHaveAttribute("aria-selected", "true")
    await expect(panel.getByRole("tab", { name: "Settings" })).toBeVisible()
    await expect(page.getByTestId("workgraph-panel-body-slot")).toBeEmpty()
    await expect(page.getByRole("dialog", { name: "Waiting on you" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Close workspace panel" })).toHaveCount(1)
    await page.getByRole("button", { name: "Close workspace panel" }).click()

    await page.getByRole("button", { name: "New stream" }).click()
    const create = page.getByRole("dialog", { name: "New stream" })
    await create.getByRole("textbox", { name: "What are you trying to ship?" }).fill("Ship the browser contract")
    await create.getByRole("textbox", { name: "Description" }).fill("Keep the WorkGraph state visible and organized.")
    await create.getByRole("button", { name: "Create" }).click()
    await expect(create).toBeHidden()

    await page.getByRole("button", { name: "Expand Ship the browser contract" }).click()
    await page.getByRole("button", { name: "Add task" }).click()
    const taskTitle = page.getByRole("textbox", { name: "Add task to Ship the browser contract" })
    await taskTitle.fill("Verify the real SQLite journey")
    await taskTitle.press("Enter")
    await expect(page.getByText("Verify the real SQLite journey", { exact: true })).toBeVisible()

    await page.getByRole("button", { name: "WorkGraph settings" }).click()
    await expect(panel).toBeVisible()
    await expect(panel.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true")
    await expect(panel.getByRole("heading", { name: "WorkGraph settings" })).toBeVisible()
    await expect(panel.getByRole("tablist", { name: "WorkGraph panel" })).toHaveCount(1)
    await panel.getByLabel("Environment").selectOption("local_worktree")
    await panel.getByLabel("Base revision").fill("dev")
    await panel.getByLabel("Isolation").selectOption("stream")
    await panel.getByLabel("Cleanup").selectOption("retain")
    await panel.getByLabel("Integration").selectOption("manual")
    await panel.getByRole("button", { name: "Save" }).click()
    await expect.poll(async () => (await readJson<DefaultsResponse>(request, "/api/workgraph/defaults")).defaults.execution).toMatchObject({
      environment: { kind: "local_worktree" },
      repository: { baseRevision: "dev" },
      isolation: "stream",
      cleanup: "retain",
      integration: "manual",
    })
    await page.getByRole("button", { name: "Close workspace panel" }).click()

    await page.getByRole("button", { name: "Stream settings for Ship the browser contract" }).click()
    const streamSettings = page.getByRole("dialog", { name: "Stream settings" })
    await expect(streamSettings.getByRole("tab")).toHaveCount(0)
    await streamSettings.getByLabel("Environment").selectOption("local_worktree")
    await streamSettings.getByLabel("Base revision").fill("HEAD")
    await streamSettings.getByLabel("Isolation").selectOption("child")
    await streamSettings.getByLabel("Cleanup").selectOption("retain")
    await streamSettings.getByLabel("Integration").selectOption("manual")
    await streamSettings.getByLabel("Quiet hours").fill("6")
    await streamSettings.getByRole("button", { name: "Save" }).click()
    await expect(streamSettings).toBeHidden()

    const streamId = await streamIdByTitle(request, "Ship the browser contract")
    await expect.poll(async () => readJson<StreamResponse>(request, `/api/workgraph/streams/${encodeURIComponent(streamId)}`)).toMatchObject({
      executionDefaults: {
        environment: { kind: "local_worktree" },
        repository: { baseRevision: "HEAD" },
        isolation: "child",
        cleanup: "retain",
        integration: "manual",
      },
      recapDefaults: { quietHours: 6 },
    })
    harness.assertHealthy()
  })

  test("reviews and confirms a real background-planned source proposal in Needs you", async ({ page, request }) => {
    await configureGeneration(request)
    const source = await command(request, {
      version: 1,
      type: "create_work_source",
      title: "Launch brief",
      content: "Ship Claxedo Cloud and verify launch readiness.",
    })
    const revision = await readJson<SourceRevisionResponse>(
      request,
      `/api/workgraph/sources/${encodeURIComponent(String(source.value.workSourceId))}/revisions/${encodeURIComponent(String(source.value.revisionId))}`,
    )
    const proposed = await command(request, {
      version: 1,
      type: "propose_admission",
      source: {
        workSourceId: String(source.value.workSourceId) as never,
        revisionId: String(source.value.revisionId) as never,
        contentHash: revision.contentHash as never,
      },
    })
    const planning = await harness.runSourcePlanning()
    expect(planning).toMatchObject({ state: "completed" })

    await page.goto("/workgraph")
    await page.getByRole("button", { name: /^Needs you — 1 waiting on you$/ }).click()
    const panel = page.getByRole("complementary", { name: "Workspace panel" })
    await expect(panel.getByRole("tab", { name: "Needs you" })).toHaveAttribute("aria-selected", "true")
    const proposal = panel.getByRole("button", { name: /Review proposed work/ })
    await proposal.click()
    const dialog = page.getByRole("dialog", { name: "Review proposed work" })
    await expect(dialog.getByText("New stream · Planned from AI context", { exact: true })).toBeVisible()
    await expect(dialog.getByRole("heading", { name: "Outcomes (1)" })).toBeVisible()
    await expect(dialog.getByRole("heading", { name: "Tasks (1)" })).toBeVisible()
    await dialog.getByRole("button", { name: "Confirm" }).click()
    await expect(dialog).toBeHidden()
    await expect(proposal).toBeHidden()
    await expect.poll(async () => readJson<ProposalResponse>(request, `/api/workgraph/proposals/${encodeURIComponent(String(proposed.value.proposalId))}`)).toMatchObject({ state: "confirmed" })
    // Confirmation is durable before the overview projection refreshes. A real
    // navigation reload proves the confirmed plan is materialized from SQLite;
    // no route interception or client-side substitute is involved.
    await page.reload()
    await expect(page.getByRole("button", { name: /^(?:Expand|Collapse) Planned from AI context$/ })).toBeVisible()
    harness.assertHealthy()
  })

  test("publishes an agent-session Recap and lazy-loads its Stream row preview on hover and focus", async ({ page, request }) => {
    await configureGeneration(request)
    await page.goto("/workgraph")
    await page.getByRole("button", { name: "New stream" }).click()
    const create = page.getByRole("dialog", { name: "New stream" })
    await create.getByRole("textbox", { name: "What are you trying to ship?" }).fill("Recap the launch")
    await create.getByRole("button", { name: "Create" }).click()
    const streamId = await streamIdByTitle(request, "Recap the launch")

    harness.advanceTime(9 * 60 * 60 * 1000)
    expect(await harness.scheduleRecaps()).toBe(1)
    const recap = await harness.runRecap()
    if (recap.state !== "completed") throw new Error(`Recap runtime did not complete: ${recap.state}`)
    expect(recap.output.generation).toMatchObject({ method: "agent_session" })
    expect(recap.output.actionableReferences).toEqual([{ type: "stream", id: streamId }])

    const recapRequests: string[] = []
    page.on("request", (request) => {
      if (/\/api\/workgraph\/recaps\//.test(new URL(request.url()).pathname)) recapRequests.push(request.url())
    })
    await page.reload()
    const trigger = page.getByRole("button", { name: "Latest recap for Recap the launch" })
    await expect(trigger).toBeVisible()
    expect(recapRequests).toHaveLength(0)

    await trigger.hover()
    const recapPreview = page.getByRole("group", { name: "Latest recap" })
    await expect(recapPreview.getByText("Stream activity is ready for review.", { exact: true })).toBeVisible()
    await expect.poll(() => recapRequests.length).toBe(1)
    await page.mouse.move(1, 1)
    await expect(recapPreview).toBeHidden()
    await trigger.focus()
    await expect(recapPreview.getByText("Stream activity is ready for review.", { exact: true })).toBeVisible()
    expect(recapRequests).toHaveLength(1)
    harness.assertHealthy()
  })

  test("executes and retries a Task in a real worktree, then inspects the true latest result from Attention", async ({ page, request }) => {
    await configureGeneration(request)
    const stream = await command(request, {
      version: 1,
      type: "create_stream",
      title: "Execution inspection",
    })
    const streamId = String(stream.value.streamId)
    const task = await command(request, {
      version: 1,
      type: "create_work_item",
      streamId: streamId as never,
      title: "Execute and inspect the launch",
      completionContract: ownerConfirmation("Inspect the real execution result"),
    })
    const workItemId = String(task.value.workItemId)

    harness.queueExecutionResults({ state: "failed", message: "Controlled first attempt failed" })
    await command(request, {
      version: 1,
      type: "execute_work_item",
      workItemId: workItemId as never,
      executionMode: "supervised",
    })
    await expect.poll(async () => {
      await harness.runReconcile()
      return (await readJson<WorkItemResponse>(request, `/api/workgraph/work-items/${encodeURIComponent(workItemId)}`)).state
    }).toBe("failed")
    expect(fs.existsSync(path.join(harness.worktreeDirectory(streamId), ".git"))).toBe(true)
    await expect.poll(async () => {
      const attention = await readJson<AttentionResponse>(request, "/api/workgraph/attention?limit=50")
      return attention.items.map((item) => ({ id: item.id, kind: item.kind, state: item.record?.state }))
    }).toContainEqual({ id: workItemId, kind: "work_item", state: "failed" })

    await page.goto("/workgraph")
    await page.getByRole("button", { name: /Needs you — 1 waiting on you/ }).click()
    const panel = page.getByRole("complementary", { name: "Workspace panel" })
    await panel.getByRole("button", { name: /Execute and inspect the launch/ }).click()
    const dialog = page.getByRole("dialog", { name: "Task" })
    await expect(dialog.getByText("#1 · failed", { exact: true })).toBeVisible()
    await expect(dialog.getByText("Controlled first attempt failed", { exact: true })).toBeVisible()

    harness.queueExecutionResults({ state: "succeeded", summary: "Retry completed in the retained worktree", artifacts: ["commit:retry-e2e"] })
    await dialog.getByRole("button", { name: "Retry task" }).click()
    await expect.poll(async () => {
      await harness.runReconcile()
      return (await readJson<WorkItemResponse>(request, `/api/workgraph/work-items/${encodeURIComponent(workItemId)}`)).state
    }).toBe("result_ready")
    await expect.poll(async () => {
      const attention = await readJson<AttentionResponse>(request, "/api/workgraph/attention?limit=50")
      return attention.items.map((item) => ({ id: item.id, kind: item.kind, state: item.record?.state }))
    }).toContainEqual({ id: workItemId, kind: "work_item", state: "result_ready" })

    await page.reload()
    await page.getByRole("button", { name: /Needs you — 1 waiting on you/ }).click()
    await panel.getByRole("button", { name: /Execute and inspect the launch/ }).click()
    await expect(dialog.getByText("#2 · result", { exact: true })).toBeVisible()
    await expect(dialog.getByText("Retry completed in the retained worktree", { exact: true })).toBeVisible()
    await expect(dialog.getByText("commit:retry-e2e", { exact: true })).toBeVisible()
    await expect(dialog.getByText("session:", { exact: false })).toBeVisible()
    harness.assertHealthy()
  })

  test("inspects a Decision, restores focus on close, and removes it from Attention only after answering", async ({ page, request }) => {
    const stream = await command(request, {
      version: 1,
      type: "create_stream",
      title: "Decision focus",
    })
    const streamId = String(stream.value.streamId)
    const task = await command(request, {
      version: 1,
      type: "create_work_item",
      streamId: streamId as never,
      title: "Implement authentication",
      completionContract: ownerConfirmation("Confirm authentication is implemented"),
    })
    const workItemId = String(task.value.workItemId)
    const proposed = await command(request, {
      version: 1,
      type: "propose_decision",
      streamId: streamId as never,
      question: "Which authentication strategy should we ship?",
      options: [
        { id: "oauth", label: "Use OAuth", description: "Delegate authentication to the provider." },
        { id: "passkeys", label: "Use passkeys", description: "Use WebAuthn credentials." },
      ],
      recommendationOptionId: "oauth",
      rationale: "OAuth fits the launch window.",
      affectedWorkItemIds: [workItemId as never],
    })
    const decisionId = String(proposed.value.decisionId)

    await page.goto("/workgraph")
    await page.getByRole("button", { name: /Needs you — 1 waiting on you/ }).click()
    const panel = page.getByRole("complementary", { name: "Workspace panel" })
    const row = panel.getByRole("button", { name: /Which authentication strategy should we ship\?/ })
    await row.focus()
    await expect(row).toBeFocused()
    await row.click()
    const dialog = page.getByRole("dialog", { name: "Decision" })
    await expect(dialog.getByText("OAuth fits the launch window.", { exact: true })).toBeVisible()
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    await expect(row).toBeFocused()

    await row.click()
    await dialog.getByRole("button", { name: /Use OAuth/ }).click()
    await expect(dialog).toBeHidden()
    await expect(row).toBeHidden()
    await expect.poll(async () => {
      const decision = await readJson<DecisionResponse>(request, `/api/workgraph/decisions/${encodeURIComponent(decisionId)}`)
      const attention = await readJson<AttentionResponse>(request, "/api/workgraph/attention?limit=50")
      return { state: decision.state, answer: decision.answer, attention: attention.total }
    }).toEqual({ state: "answered", answer: { optionId: "oauth" }, attention: 0 })
    harness.assertHealthy()
  })
})

const generationDefaults = {
  execution: {
    environment: { kind: "local_worktree" as const },
    repository: { baseRevision: "HEAD" },
    harness: "claxedo-v2",
    agent: "build",
    model: { providerId: "openai", modelId: "gpt-5" },
    effort: "high",
    tools: [],
    connectionIds: [],
    isolation: "stream" as const,
    cleanup: "retain" as const,
    integration: "manual" as const,
  },
  recap: { quietHours: 8 },
}

async function configureGeneration(request: APIRequestContext) {
  await command(request, {
    version: 1,
    type: "update_workgraph_defaults",
    expectedVersion: 1,
    defaults: generationDefaults,
  })
}

async function command(request: APIRequestContext, input: WorkGraphCommandRequest["command"]) {
  const response = await request.post(`${harness.apiUrl}/api/workgraph/commands`, {
    data: { operationId: crypto.randomUUID(), command: input },
  })
  const result = await response.json() as CommandResult
  if (!response.ok() || !result.ok) {
    const message = result.ok ? `WorkGraph command returned HTTP ${response.status()}` : result.error.message
    throw new Error(message)
  }
  return result
}

async function readJson<Value>(request: APIRequestContext, pathname: string) {
  const response = await request.get(`${harness.apiUrl}${pathname}`)
  if (!response.ok()) throw new Error(`WorkGraph read failed (${response.status()}): ${pathname}`)
  return await response.json() as Value
}

async function streamIdByTitle(request: APIRequestContext, title: string) {
  await expect.poll(async () =>
    (await readJson<SnapshotResponse>(request, "/api/workgraph/snapshot")).records.find(
      (record) => record.recordType === "stream" && record.title === title,
    )?.id,
  ).toBeTruthy()
  const records = (await readJson<SnapshotResponse>(request, "/api/workgraph/snapshot")).records
  const stream = records.find((record) => record.recordType === "stream" && record.title === title)
  if (!stream) throw new Error(`Stream was not found: ${title}`)
  return stream.id
}

function ownerConfirmation(description: string) {
  return {
    version: 1 as const,
    mode: "all" as const,
    requirements: [{ id: crypto.randomUUID(), kind: "owner_confirmation" as const, description }],
  }
}

type DefaultsResponse = Readonly<{
  defaults: Readonly<{ execution: Record<string, unknown>; recap: Record<string, unknown> }>
}>
type SnapshotResponse = Readonly<{ records: Array<Readonly<{ recordType: string; id: string; title?: string }>> }>
type StreamResponse = Readonly<{ executionDefaults: Record<string, unknown>; recapDefaults: Record<string, unknown> }>
type SourceRevisionResponse = Readonly<{ contentHash: string }>
type ProposalResponse = Readonly<{ state: string }>
type WorkItemResponse = Readonly<{ version: number; state: string }>
type AttentionResponse = Readonly<{
  total: number
  items: Array<Readonly<{ id: string; kind: string; record: Readonly<{ state: string }> }>>
}>
type DecisionResponse = Readonly<{ state: string; answer?: Readonly<{ optionId?: string; answer?: string }> }>
