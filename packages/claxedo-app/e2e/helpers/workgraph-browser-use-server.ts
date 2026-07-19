import os from "node:os"
import path from "node:path"
import { createRealWorkGraphHarness } from "./real-workgraph-harness.ts"

const port = Number(process.env.CLAXEDO_WORKGRAPH_BROWSER_API_PORT ?? 4312)
const temporaryRoot = process.env.CLAXEDO_WORKGRAPH_BROWSER_DATA
  ? path.resolve(process.env.CLAXEDO_WORKGRAPH_BROWSER_DATA)
  : os.tmpdir()
const harness = await createRealWorkGraphHarness({ port, temporaryRoot })
if (process.env.CLAXEDO_WORKGRAPH_BROWSER_SEED !== "0") await seedVisualStates()
let closing = false

const close = async () => {
  if (closing) return
  closing = true
  await harness.close()
}

process.on("SIGINT", () => void close().finally(() => process.exit(0)))
process.on("SIGTERM", () => void close().finally(() => process.exit(0)))
console.log(`WorkGraph Browser Use server listening on ${harness.apiUrl}; data: ${harness.directory}`)

async function seedVisualStates() {
  const context = {
    organizationId: "local",
    ownerUserId: "local",
    actor: { type: "user" as const, id: "local" },
    requestId: crypto.randomUUID(),
    access: { mode: "owner" as const },
  }
  const execute = async (command: Record<string, unknown>) => {
    const result = await harness.embedded.service.execute(context as never, {
      operationId: crypto.randomUUID() as never,
      command: { version: 1, ...command } as never,
    })
    if (!result.ok) throw new Error(result.error.message)
    if (typeof result.value !== "object" || !result.value || Array.isArray(result.value)) {
      throw new Error(`Visual fixture command ${String(command.type)} returned no record`)
    }
    return result.value
  }
  const execution = {
    environment: { kind: "local_worktree", directory: path.resolve(import.meta.dirname, "../../../..") },
    repository: { baseRevision: "HEAD" },
    harness: "opencode",
    agent: "build",
    model: { providerId: "openai", modelId: "gpt-5" },
    effort: "high",
    tools: ["read", "edit"],
    connectionIds: [],
  }
  const completionContract = (description: string) => ({
    version: 1,
    mode: "all",
    requirements: [{ id: crypto.randomUUID(), kind: "owner_confirmation", description }],
  })

  const delivery = await execute({ type: "create_stream", title: "Serialized delivery", execution })
  harness.queueExecutionResults("running")
  await execute({
    type: "create_work_item",
    streamId: delivery.streamId,
    title: "Verify the active release",
    completionContract: completionContract("Owner reviews the active release"),
  })
  await execute({
    type: "create_work_item",
    streamId: delivery.streamId,
    title: "Publish the follow-up",
    completionContract: completionContract("Owner reviews the follow-up"),
  })

  const paused = await execute({ type: "create_stream", title: "Paused migration", execution })
  await execute({
    type: "set_stream_lifecycle",
    streamId: paused.streamId,
    expectedVersion: 1,
    state: "paused",
    reason: "Review the migration boundary",
  })
  await execute({
    type: "create_work_item",
    streamId: paused.streamId,
    title: "Resume after approval",
    completionContract: completionContract("Owner confirms the migration boundary"),
  })

  const receipts = await execute({ type: "create_stream", title: "Auditable landing", execution })
  harness.queueExecutionResults("running")
  const completed = await execute({
    type: "create_work_item",
    streamId: receipts.streamId,
    title: "Land the reviewed change",
    completionContract: completionContract("Owner reviews the landing"),
  })
  await harness.completeControlledAttempt(
    String(completed.workItemId),
    "The landing reached its review boundary",
    ["diff:visual-landing"],
  )
}
