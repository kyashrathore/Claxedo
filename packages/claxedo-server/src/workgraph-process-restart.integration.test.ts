import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { afterEach, describe, expect, test } from "vitest"

type RestartProcess = ChildProcessByStdio<null, Readable, Readable>

type FixtureProcess = Readonly<{
  child: RestartProcess
  origin: string
}>

const processes: RestartProcess[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(processes.splice(0).map(stopProcess))
  directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
})

describe("local WorkGraph process recovery", () => {
  test("recovers one durable Run through a real server restart and explicit reconciliation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-workgraph-process-restart-"))
    directories.push(directory)
    const repository = path.join(directory, "repository")
    fs.mkdirSync(repository)
    execFileSync("git", ["init", "--initial-branch=restart-test"], { cwd: repository })
    fs.writeFileSync(path.join(repository, "README.md"), "# restart fixture\n")
    execFileSync("git", ["add", "README.md"], { cwd: repository })
    execFileSync(
      "git",
      ["-c", "user.name=Claxedo Test", "-c", "user.email=test@claxedo.local", "commit", "-m", "fixture"],
      { cwd: repository },
    )
    const database = path.join(directory, "workgraph.sqlite")

    const first = await startFixture(database, repository)
    const stream = (await command(first.origin, "restart_stream", {
      version: 1,
      type: "create_stream",
      title: "Recover after process loss",
      execution: {
        ...executionProfile,
        environment: { kind: "local_worktree", placement: "shared", directory: repository },
      },
    })) as { value: { streamId: string } }
    const item = (await command(first.origin, "restart_item", {
      version: 1,
      type: "create_work_item",
      streamId: stream.value.streamId,
      title: "Preserve the admitted work",
      completionContract: {
        version: 1,
        mode: "all",
        requirements: [{ id: "restart-proof", kind: "test", description: "Process recovery passes" }],
      },
    })) as { value: { workItemId: string } }
    // Execution modes are gone: the local (owner) create is born `pending`
    // (approved) and the embedded drain admits + launches it. Discover the durable
    // Run from the snapshot instead of an execute command's response.
    const createItemRequest = {
      version: 1,
      type: "create_work_item",
      streamId: stream.value.streamId,
      title: "Preserve the admitted work",
      completionContract: {
        version: 1,
        mode: "all",
        requirements: [{ id: "restart-proof", kind: "test", description: "Process recovery passes" }],
      },
    } as const
    const beforeCrash = await snapshot(first.origin)
    const beforeRuns = beforeCrash.records.filter((record) => record.recordType === "run")
    expect(beforeRuns).toEqual([
      expect.objectContaining({ ownerUserId: "local", state: "running" }),
    ])
    const runId = (beforeRuns[0] as { id: string }).id
    const firstRuntime = await get<{ sessions: Record<string, { admissionCount: number; result: { state: string } }> }>(
      first.origin,
      "/runtime/sessions",
    )
    expect(firstRuntime.sessions[`session_${runId}`]).toMatchObject({
      admissionCount: 1,
      result: { state: "pending" },
    })

    first.child.kill("SIGKILL")
    await exited(first.child)
    processes.splice(processes.indexOf(first.child), 1)

    const second = await startFixture(database, repository)
    // operationId idempotency across SIGKILL: replaying the original create with
    // its stored operationId returns the same Work Item and never materializes a
    // second Task; the durable Run survives and the boot drain does not
    // relaunch it (the item is `active`, not `pending`).
    const replay = (await command(second.origin, "restart_item", createItemRequest)) as { value: { workItemId: string } }
    expect(replay.value.workItemId).toBe(item.value.workItemId)
    const afterRestart = await snapshot(second.origin)
    expect(afterRestart.records.filter((record) => record.recordType === "run")).toEqual([
      expect.objectContaining({ id: runId, ownerUserId: "local", state: "running" }),
    ])
    const restartedRuntime = await get<{ sessions: Record<string, { admissionCount: number; directory: string }> }>(
      second.origin,
      "/runtime/sessions",
    )
    expect(Object.keys(restartedRuntime.sessions)).toEqual([`session_${runId}`])
    expect(restartedRuntime.sessions[`session_${runId}`]).toMatchObject({ admissionCount: 1 })
    expect(restartedRuntime.sessions[`session_${runId}`].directory).toContain(
      path.join(repository, ".claxedo-workgraph-worktrees"),
    )

    await post(second.origin, `/runtime/sessions/session_${runId}/complete`, {
      summary: "Recovered process completed the original Run",
      artifacts: ["commit:restart-proof"],
    })
    expect(await post(second.origin, "/runtime/reconcile", {})).toMatchObject({
      results: [expect.objectContaining({ settled: false, awaitingExplicitCompletion: true })],
    })
    await command(second.origin, "restart_explicit_completion", {
      version: 1,
      type: "complete_run",
      runId: runId,
      sessionId: `session_${runId}`,
      workspaceId: restartedRuntime.sessions[`session_${runId}`].directory,
      generation: 1,
      summary: "Recovered process completed the original Run",
      artifacts: ["commit:restart-proof"],
      evidence: [{
        requirementId: "restart-proof",
        evidence: { kind: "test_result", summary: "Owner verification pending", passed: false },
      }],
    })

    const settled = await snapshot(second.origin)
    expect(settled.records.filter((record) => record.recordType === "run")).toEqual([
      expect.objectContaining({
        id: runId,
        ownerUserId: "local",
        state: "result",
        result: expect.objectContaining({
          summary: "Recovered process completed the original Run",
          artifactRefs: ["commit:restart-proof"],
        }),
      }),
    ])
    expect(settled.records).toContainEqual(
      expect.objectContaining({
        recordType: "work_item",
        id: item.value.workItemId,
        ownerUserId: "local",
        state: "result_ready",
      }),
    )
    expect(
      await get<{ items: unknown[]; total: number }>(second.origin, "/api/workgraph/attention?limit=50"),
    ).toMatchObject({
      total: 1,
      items: [
        expect.objectContaining({
          kind: "work_item",
          id: item.value.workItemId,
          ownerUserId: "local",
          record: expect.objectContaining({ state: "result_ready" }),
        }),
      ],
    })
  }, 60_000)
})

const executionProfile = {
  environment: { kind: "local_worktree", placement: "shared" },
  repository: { baseRevision: "HEAD" },
  harness: "restart-harness",
  agent: "build",
  model: { providerId: "test-provider", modelId: "restart-model" },
  effort: "high",
  tools: [],
  connectionIds: [],
}

async function startFixture(database: string, repository: string): Promise<FixtureProcess> {
  const child = spawn(
    "node",
    [
      "--conditions=development",
      "--import",
      "tsx",
      path.join(import.meta.dirname, "workgraph-process-restart.fixture.ts"),
    ],
    {
      cwd: path.join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        CLAXEDO_TEST_WORKGRAPH_DATABASE: database,
        CLAXEDO_TEST_WORKGRAPH_REPOSITORY: repository,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  processes.push(child)
  let errors = ""
  child.stderr.on("data", (chunk) => {
    errors += String(chunk)
  })
  const ready = await new Promise<{ port: number }>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => reject(new Error(`Fixture did not start\n${errors}`)), 20_000)
    child.stdout.on("data", (chunk) => {
      output += String(chunk)
      const line = output.split("\n").find((candidate) => candidate.includes('"ready":true'))
      if (!line) return
      clearTimeout(timer)
      resolve(JSON.parse(line) as { port: number })
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`Fixture exited before ready (${code ?? signal})\n${errors}`))
    })
  })
  return { child, origin: `http://127.0.0.1:${ready.port}` }
}

async function command(origin: string, operationId: string, commandBody: Record<string, unknown>) {
  return post(origin, "/api/workgraph/commands", { operationId, command: commandBody })
}

async function snapshot(origin: string) {
  return get<{ records: Array<Record<string, unknown>> }>(origin, "/api/workgraph/snapshot")
}

async function get<Value>(origin: string, pathname: string): Promise<Value> {
  const response = await fetch(`${origin}${pathname}`, { headers: { "x-request-id": crypto.randomUUID() } })
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}: ${await response.text()}`)
  return response.json() as Promise<Value>
}

async function post(origin: string, pathname: string, body: unknown) {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID() },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}: ${await response.text()}`)
  return response.json()
}

async function stopProcess(child: RestartProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([exited(child), new Promise<void>((resolve) => setTimeout(resolve, 5_000))])
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
}

function exited(child: RestartProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => child.once("exit", () => resolve()))
}
