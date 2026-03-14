# WorkGraph -> Inngest Subtree Prototype

This is a concrete prototype for how WorkGraph could turn a selected executable subtree into an Inngest-backed durable run without giving up the existing WorkGraph graph model.

The idea is:

- WorkGraph remains the source of truth for nodes, edges, slices, and sync-back.
- A selected subtree is compiled into a bounded execution plan.
- An Inngest function becomes the durable coordinator for that plan.
- Each runnable node is executed through a child function that routes work to:
  - a local worktree/session
  - a remote VM
  - a cloud task worker

This is a good fit when:

- the subtree is bounded at start time
- dependencies are known
- execution may take a long time
- nodes may run in parallel
- the run should survive retries, waits, and process restarts

It is not the whole product architecture. It is the minimum bridge from `WorkGraph subtree -> durable multi-step run`.

## Mapping

| WorkGraph | Inngest |
|---|---|
| `work_item` | node in compiled plan |
| `edge` | dependency in compiled plan |
| `run` | coordinator function run |
| `node attempt` | child function run |
| `approval/wait` | `step.waitForEvent()` |
| `parallel ready set` | `Promise.all(step.invoke(...))` |
| `schedule` | cron trigger or delayed event |

## Types

```ts
export type Placement =
  | {
      kind: "local_worktree"
      project_id: string
      directory: string
      branch: string
      worktree_id: string
    }
  | {
      kind: "remote_vm"
      vm_id: string
      directory: string
      branch: string
    }
  | {
      kind: "cloud_task"
      queue: string
    }

export type Node = {
  id: string
  title: string
  prompt: string
  kind: string
  deps: string[]
  placement: Placement
}

export type Stage = {
  index: number
  node_ids: string[]
}

export type Plan = {
  run_id: string
  root_id: string
  node_ids: string[]
  nodes: Record<string, Node>
  stages: Stage[]
}
```

## 1. Compile a subtree into stages

This compiler assumes:

- we start from a chosen root node
- we walk all downstream dependents
- we keep only dependencies inside that subtree
- we topologically stage nodes so each stage can run in parallel

```ts
type Item = {
  id: string
  title: string
  description: string
  labels: string[]
  status: "open" | "in_progress" | "done"
}

type Edge = {
  source: string
  target: string
}

function descendants(root: string, edges: Edge[]) {
  const seen = new Set<string>([root])
  const out = new Map<string, string[]>()
  for (const edge of edges) {
    const list = out.get(edge.source) ?? []
    list.push(edge.target)
    out.set(edge.source, list)
  }
  const q = [root]
  while (q.length) {
    const id = q.shift()!
    for (const child of out.get(id) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      q.push(child)
    }
  }
  return seen
}

function placement(item: Item): Placement {
  if (item.labels.includes("code")) {
    return {
      kind: "local_worktree",
      project_id: "proj_local",
      directory: "/repo",
      branch: `wg/${item.id}`,
      worktree_id: `wt_${item.id}`,
    }
  }

  if (item.labels.includes("vm")) {
    return {
      kind: "remote_vm",
      vm_id: "vm_default",
      directory: "/workspace/repo",
      branch: `wg/${item.id}`,
    }
  }

  return {
    kind: "cloud_task",
    queue: "default",
  }
}

export function compileSubtree(runId: string, rootId: string, items: Item[], edges: Edge[]): Plan {
  const ids = descendants(rootId, edges)
  const kept = items.filter((item) => ids.has(item.id))
  const scoped = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))

  const nodes = Object.fromEntries(
    kept.map((item) => [
      item.id,
      {
        id: item.id,
        title: item.title,
        prompt: item.description || `Execute ${item.title}`,
        kind: item.labels[0] ?? "task",
        deps: scoped.filter((edge) => edge.target === item.id).map((edge) => edge.source),
        placement: placement(item),
      } satisfies Node,
    ]),
  )

  const indegree = new Map<string, number>(
    kept.map((item) => [item.id, 0]),
  )
  for (const edge of scoped) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }

  const stages: Stage[] = []
  let pending = kept.map((item) => item.id)
  let index = 0

  while (pending.length) {
    const ready = pending.filter((id) => (indegree.get(id) ?? 0) === 0)
    if (!ready.length) throw new Error("Cycle detected while compiling subtree")

    stages.push({ index, node_ids: ready })

    for (const id of ready) {
      for (const edge of scoped.filter((edge) => edge.source === id)) {
        indegree.set(edge.target, (indegree.get(edge.target) ?? 0) - 1)
      }
    }

    pending = pending.filter((id) => !ready.includes(id))
    index++
  }

  return {
    run_id: runId,
    root_id: rootId,
    node_ids: kept.map((item) => item.id),
    nodes,
    stages,
  }
}
```

## 2. Store the compiled plan in your DB

The coordinator should not carry the whole graph in memory.

Persist the compiled plan before triggering Inngest:

```ts
export async function createRunFromSubtree(rootId: string) {
  const runId = `run_${crypto.randomUUID()}`
  const items = await db.workItems()
  const edges = await db.workEdges()
  const plan = compileSubtree(runId, rootId, items, edges)

  await db.insertRun({
    run_id: runId,
    root_id: rootId,
    status: "queued",
  })

  await db.insertPlan(plan)

  await inngest.send({
    name: "workgraph/run.started",
    data: { runId },
    id: `workgraph-run-${runId}`,
  })

  return { runId }
}
```

## 3. Coordinator function

This is the durable wrapper around the subtree.

It:

- loads the compiled plan
- executes stage by stage
- runs all nodes in a stage in parallel
- waits for their results
- commits stage results back to WorkGraph

```ts
import { Inngest } from "inngest"

export const inngest = new Inngest({ id: "workgraph" })

export const runSubtree = inngest.createFunction(
  {
    id: "workgraph-run-subtree",
    retries: 0,
    concurrency: [
      {
        key: "event.data.runId",
        limit: 1,
      },
    ],
  },
  { event: "workgraph/run.started" },
  async ({ event, step }) => {
    const plan = await step.run("load-plan", async () => {
      return db.getPlan(event.data.runId) as Plan
    })

    await step.run("mark-run-executing", async () => {
      await db.updateRun(plan.run_id, { status: "executing" })
      await db.appendTrace(plan.run_id, {
        type: "run_started",
        payload: { root_id: plan.root_id },
      })
    })

    for (const stage of plan.stages) {
      const results = await Promise.all(
        stage.node_ids.map((nodeId) =>
          step.invoke(`node-${stage.index}-${nodeId}`, {
            function: executeNode,
            data: {
              runId: plan.run_id,
              nodeId,
            },
          }),
        ),
      )

      await step.run(`commit-stage-${stage.index}`, async () => {
        for (const result of results) {
          if (result.status === "completed") {
            await db.markNodeDone(plan.run_id, result.nodeId, result.output)
            continue
          }

          await db.markNodeFailed(plan.run_id, result.nodeId, result.error)
          throw new Error(`Node ${result.nodeId} failed: ${result.error}`)
        }
      })
    }

    await step.run("mark-run-complete", async () => {
      await db.updateRun(plan.run_id, { status: "completed" })
      await db.appendTrace(plan.run_id, {
        type: "run_completed",
        payload: {},
      })
    })

    return { runId: plan.run_id, status: "completed" as const }
  },
)
```

## 4. Node executor function

This function routes execution by placement.

It is intentionally thin:

- local code work is still done by Claxedo sessions/worktrees
- remote VM work is delegated to your VM control plane
- cloud work stays headless

```ts
type NodeResult =
  | {
      status: "completed"
      nodeId: string
      output?: Record<string, unknown>
    }
  | {
      status: "failed"
      nodeId: string
      error: string
    }

export const executeNode = inngest.createFunction(
  {
    id: "workgraph-execute-node",
    retries: 2,
  },
  { event: "workgraph/node.execute" },
  async ({ event, step }) => {
    const node = await step.run("load-node", async () => {
      return db.getRunNode(event.data.runId, event.data.nodeId) as Node
    })

    await step.run("mark-node-active", async () => {
      await db.markNodeActive(event.data.runId, node.id)
      await db.appendTrace(event.data.runId, {
        type: "node_started",
        node_id: node.id,
        payload: { placement: node.placement },
      })
    })

    if (node.placement.kind === "cloud_task") {
      const output = await step.run("run-cloud-task", async () => {
        return cloud.execute({
          nodeId: node.id,
          prompt: node.prompt,
          queue: node.placement.queue,
        })
      })

      return {
        status: "completed",
        nodeId: node.id,
        output,
      } satisfies NodeResult
    }

    if (node.placement.kind === "remote_vm") {
      const dispatch = await step.run("dispatch-vm-job", async () => {
        return vm.start({
          vmId: node.placement.vm_id,
          branch: node.placement.branch,
          directory: node.placement.directory,
          nodeId: node.id,
          prompt: node.prompt,
        })
      })

      const done = await step.waitForEvent(`wait-vm-${node.id}`, {
        event: "workgraph/node.finished",
        timeout: "24h",
        if: `event.data.runId == "${event.data.runId}" && async.data.nodeId == "${node.id}"`,
      })

      if (!done) {
        return {
          status: "failed",
          nodeId: node.id,
          error: `Timed out waiting for VM attempt ${dispatch.attemptId}`,
        } satisfies NodeResult
      }

      return {
        status: "completed",
        nodeId: node.id,
        output: done.data.output,
      } satisfies NodeResult
    }

    const launch = await step.run("launch-session", async () => {
      return session.start({
        projectId: node.placement.project_id,
        directory: node.placement.directory,
        branch: node.placement.branch,
        worktreeId: node.placement.worktree_id,
        nodeId: node.id,
        prompt: node.prompt,
      })
    })

    const finished = await step.waitForEvent(`wait-session-${node.id}`, {
      event: "workgraph/node.finished",
      timeout: "24h",
      if: `event.data.runId == "${event.data.runId}" && async.data.nodeId == "${node.id}"`,
    })

    if (!finished) {
      return {
        status: "failed",
        nodeId: node.id,
        error: `Timed out waiting for session ${launch.sessionId}`,
      } satisfies NodeResult
    }

    return {
      status: "completed",
      nodeId: node.id,
      output: {
        sessionId: launch.sessionId,
        ...finished.data.output,
      },
    } satisfies NodeResult
  },
)
```

## 5. Event bridge for local sessions and VMs

Interactive session work and VM work should report completion back into Inngest by emitting events.

```ts
export async function onNodeFinished(input: {
  runId: string
  nodeId: string
  ok: boolean
  output?: Record<string, unknown>
  error?: string
}) {
  await inngest.send({
    name: "workgraph/node.finished",
    data: input,
    id: `workgraph-node-finished-${input.runId}-${input.nodeId}-${Date.now()}`,
  })
}
```

This is the bridge that lets:

- a local session stay interactive
- a remote VM keep running elsewhere
- the durable coordinator continue only when the node really finishes

## 6. Multi-step node bodies

If a single node itself should be durable and multi-step, the child function can break its work into steps too.

For example, a remote analysis node:

```ts
export const analyzeNode = inngest.createFunction(
  { id: "workgraph-analyze-node", retries: 2 },
  { event: "workgraph/node.analyze" },
  async ({ event, step }) => {
    const data = await step.run("fetch-brief", async () => {
      return db.getNodeBrief(event.data.nodeId)
    })

    const summary = await step.run("call-model", async () => {
      return ai.summarize(data.prompt)
    })

    await step.run("store-summary", async () => {
      await db.storeNodeArtifact(event.data.nodeId, {
        kind: "summary",
        body: summary,
      })
    })

    return { summary }
  },
)
```

That gives you two levels:

- **coordinator steps** for subtree orchestration
- **node steps** for internal node execution

## 7. When this prototype works well

This pattern is strong for:

- bounded subtree execution
- durable waits
- approval gates
- schedules
- remote/background work
- mixed local and remote placements

## 8. Where this prototype gets stretched

You would need a more dynamic scheduler if you want:

- huge graphs
- dynamic node insertion during a run
- re-planning mid-run
- many thousands of nodes
- arbitrary graph mutation while executing

At that point, the coordinator should stop using precompiled `stages` and instead:

- load current graph state from DB each cycle
- compute ready nodes
- dispatch a batch
- wait for completions
- loop

That is still compatible with Inngest, but the coordinator becomes more stateful.

## 9. Recommended next experiment

If you want to validate this quickly:

1. Add an `inngest` package to a tiny playground service.
2. Implement just:
   - `compileSubtree`
   - `runSubtree`
   - `executeNode`
3. Stub placements:
   - local session -> fake completion event
   - remote VM -> fake completion event
   - cloud task -> direct step
4. Run one subtree with:
   - one code node
   - one remote node
   - one dependent review node

That will tell you very quickly whether Inngest feels like a helpful durable coordinator or whether it starts dictating too much of the shape.
