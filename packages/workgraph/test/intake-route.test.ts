import { afterEach, describe, expect, test, vi } from "vitest"
import Database from "better-sqlite3"
import { createApp, initializeDb } from "../src/app"
import { createTriageDebouncer } from "../src/captain/triage-runner"
import { getWorkGraph, resetWorkGraph } from "../src/model/registry"

function post(body: unknown) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

function issuePayload(action = "opened", body = "The capture box should not open a session.") {
  return {
    action,
    issue: {
      number: 42,
      title: "Async intake bug",
      body,
      state: action === "closed" ? "closed" : "open",
      html_url: "https://github.com/acme/app/issues/42",
    },
    repository: {
      full_name: "acme/app",
      html_url: "https://github.com/acme/app",
    },
  }
}

function githubWebhook(payload: unknown, opts: {
  signature?: string
  delivery?: string
  event?: string
} = {}) {
  const body = JSON.stringify(payload)
  return {
    method: "POST" as const,
    headers: {
      "Content-Type": "application/json",
      "webhook-id": opts.delivery ?? "delivery-1",
      "webhook-signature": opts.signature ?? "valid",
      "webhook-timestamp": "1777680000",
      "X-GitHub-Event": opts.event ?? "issues",
    },
    body,
  }
}

function withGitHubWebhookVerifier(scheduled?: string[]) {
  return {
    intake: {
      scheduleTriage: scheduled ? (id: string) => scheduled.push(id) : undefined,
      verifyGitHubWebhook: async (input: { raw: string; headers: Headers }) => {
        if (input.headers.get("webhook-signature") !== "valid") return null
        return {
          deliveryId: input.headers.get("webhook-id") ?? "delivery-1",
          event: input.headers.get("X-GitHub-Event") ?? "issues",
          payload: JSON.parse(input.raw) as unknown,
        }
      },
    },
  }
}

describe("Intake routes", () => {
  afterEach(() => {
    vi.useRealTimers()
    resetWorkGraph()
  })

  test("POST /intake captures manual intake and schedules triage", async () => {
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const scheduled: string[] = []
    const app = createApp(db, { intake: { scheduleTriage: (id) => scheduled.push(id) } })

    const res = await app.request("/intake", post({
      body_md: "Please split this into implementation work.",
      repo_ref: "github:acme/app",
      triageMode: "normal",
    }))

    expect(res.status).toBe(201)
    const body = await res.json() as { intakeItemId: string; sessionId: string | null }
    expect(body).toEqual({ intakeItemId: expect.any(String), sessionId: null })
    expect(getWorkGraph().getIntakeItem(body.intakeItemId)).toEqual(expect.objectContaining({
      kind: "manual",
      bodyMd: "Please split this into implementation work.",
      repoRef: "github:acme/app",
      triageModeOverride: "normal",
    }))
    expect(getWorkGraph().getState().intakeActivities.map((activity) => activity.kind)).toEqual(["capture"])
    expect(scheduled).toEqual([body.intakeItemId])
  })

  test("POST /intake schedules visible triage through the configured execution adapter", async () => {
    vi.useFakeTimers()
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const launched: Array<{ kind: string; hidden?: boolean; prompt: string }> = []
    const app = createApp(db, {
      execution: {
        launch: async (input) => {
          launched.push({ kind: input.kind, hidden: input.hidden, prompt: input.prompt })
          expect(input.node_id).toBeDefined()
          if (input.kind === "triage") {
            expect(input.prompt).toContain("Please triage this intake.")
            expect(input.prompt).toContain(`run_id = ${input.run_id}`)
            getWorkGraph().writeScratchpad({
              workItemId: input.node_id,
              agentRunId: input.run_id,
              kind: "triage",
              content: "Triage complete.",
              actor: "triage",
            })
            return { id: "session_1", session_id: "session_1" }
          }
          expect(input.kind).toBe("captain")
          expect(input.hidden).toBe(true)
          expect(input.prompt).toContain("workgraph_propose_create_node")
          return { id: "captain_session_1", session_id: "captain_session_1" }
        },
      },
    })

    const res = await app.request("/intake", post({
      body_md: "Please triage this intake.",
      triageMode: "normal",
    }))
    const body = await res.json() as { intakeItemId: string; sessionId: string | null }

    expect(res.status).toBe(201)
    expect(body.sessionId).toBeNull()

    await vi.advanceTimersByTimeAsync(100)

    expect(launched.map((item) => item.kind)).toEqual(["triage", "captain"])
    expect(launched[1]).toEqual(expect.objectContaining({ hidden: true }))
    expect(getWorkGraph().getIntakeItem(body.intakeItemId)).toEqual(expect.objectContaining({
      status: "triaged",
      linkedSessionId: "session_1",
    }))
  })

  test("GET /intake lists and filters captured intake items", async () => {
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const app = createApp(db)
    const first = getWorkGraph().captureIntakeItem({
      bodyMd: "Repo item",
      repoRef: "github:acme/app",
    })
    getWorkGraph().captureIntakeItem({
      bodyMd: "Other repo item",
      repoRef: "github:other/app",
    })

    const res = await app.request("/intake?repoRef=github%3Aacme%2Fapp&status=captured")
    const body = await res.json() as { items: Array<{ id: string }> }

    expect(res.status).toBe(200)
    expect(body.items).toEqual([expect.objectContaining({ id: first.id })])
  })

  test("PATCH and DELETE /intake clean up staged intake", async () => {
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const app = createApp(db)
    const item = getWorkGraph().captureIntakeItem({
      bodyMd: "Cleanup me",
    })

    const archived = await app.request(`/intake/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    })
    expect(archived.status).toBe(200)
    expect(await archived.json()).toEqual({
      item: expect.objectContaining({
        id: item.id,
        status: "archived",
      }),
    })

    const deleted = await app.request(`/intake/${item.id}`, { method: "DELETE" })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })
    expect(getWorkGraph().getIntakeItem(item.id)).toBeUndefined()
  })

  test("GitHub webhook with a valid signature creates intake and external reference", async () => {
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const scheduled: string[] = []
    const app = createApp(db, withGitHubWebhookVerifier(scheduled))

    const res = await app.request("/intake/webhooks/github", githubWebhook(issuePayload()))

    expect(res.status).toBe(200)
    const body = await res.json() as { intakeItemId: string; deduped: boolean }
    expect(body).toEqual({ intakeItemId: expect.any(String), deduped: false })
    expect(Object.values(getWorkGraph().getState().externalReferences)).toEqual([
      expect.objectContaining({
        intakeItemId: body.intakeItemId,
        provider: "github",
        externalId: "acme/app#42",
      }),
    ])
    expect(getWorkGraph().getState().intakeActivities.map((activity) => activity.kind)).toEqual(["capture"])
    expect(scheduled).toEqual([body.intakeItemId])
  })

  test("GitHub webhook deduplicates repeated deliveries", async () => {
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const scheduled: string[] = []
    const app = createApp(db, withGitHubWebhookVerifier(scheduled))

    const first = await app.request("/intake/webhooks/github", githubWebhook(issuePayload()))
    const second = await app.request("/intake/webhooks/github", githubWebhook(issuePayload()))

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ deduped: true })
    expect(Object.values(getWorkGraph().getState().intakeItems)).toHaveLength(1)
    expect(scheduled).toHaveLength(1)
  })

  test("GitHub webhook rejects invalid signatures without writes", async () => {
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const app = createApp(db, withGitHubWebhookVerifier())

    const res = await app.request("/intake/webhooks/github", githubWebhook(issuePayload(), { signature: "invalid" }))

    expect(res.status).toBe(401)
    expect(Object.values(getWorkGraph().getState().intakeItems)).toHaveLength(0)
  })

  test("GitHub webhook appends activity for an existing external issue", async () => {
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const scheduled: string[] = []
    const app = createApp(db, withGitHubWebhookVerifier(scheduled))

    await app.request("/intake/webhooks/github", githubWebhook(issuePayload(), { delivery: "delivery-1" }))
    await app.request("/intake/webhooks/github", githubWebhook(issuePayload("edited", "Updated details."), { delivery: "delivery-2" }))

    expect(Object.values(getWorkGraph().getState().intakeItems)).toHaveLength(1)
    expect(getWorkGraph().getState().intakeActivities.map((activity) => activity.kind)).toEqual(["capture", "external_edit"])
    expect(scheduled).toHaveLength(2)
  })

  test("GitHub webhook bursts schedule one debounced triage run per issue", async () => {
    vi.useFakeTimers()
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const runs: string[] = []
    const debouncer = createTriageDebouncer((id) => {
      runs.push(id)
      return Promise.resolve()
    }, 500)
    const app = createApp(db, {
      intake: {
        scheduleTriage: (id) => debouncer.schedule(id),
        verifyGitHubWebhook: withGitHubWebhookVerifier().intake.verifyGitHubWebhook,
      },
    })

    for (const idx of [1, 2, 3, 4, 5]) {
      await app.request("/intake/webhooks/github", githubWebhook(issuePayload(idx === 1 ? "opened" : "edited"), { delivery: `delivery-${idx}` }))
    }
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(500)

    expect(runs).toHaveLength(1)
  })
})
