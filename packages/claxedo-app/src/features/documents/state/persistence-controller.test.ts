import { describe, expect, test } from "bun:test"
import {
  createDocumentPersistenceController,
  type PersistenceScheduler,
  type SaveRequest,
  type SaveResponse,
} from "./persistence-controller"
import { createRecoveryDraftStore, type RecoveryDraftStorage } from "./recovery-draft"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function manualScheduler() {
  const pending: Array<{ handler: () => void; delay: number; cancelled: boolean }> = []
  const schedule: PersistenceScheduler = (handler, delay) => {
    const timer = { handler, delay, cancelled: false }
    pending.push(timer)
    return () => {
      timer.cancelled = true
    }
  }
  return {
    schedule,
    delays: () => pending.filter((timer) => !timer.cancelled).map((timer) => timer.delay),
    runNext() {
      const timer = pending.find((candidate) => !candidate.cancelled)
      if (!timer) throw new Error("No scheduled task")
      timer.cancelled = true
      timer.handler()
    },
  }
}

function memoryStorage(): RecoveryDraftStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

function setup(input?: {
  save?: (request: SaveRequest) => Promise<SaveResponse>
  storage?: RecoveryDraftStorage
  retryDelays?: readonly number[]
  document?: { id: string; displayName: string; markdown: string; version: string }
}) {
  const scheduler = manualScheduler()
  const requests: SaveRequest[] = []
  const reportedErrors: unknown[] = []
  const storage = input?.storage ?? memoryStorage()
  const controller = createDocumentPersistenceController({
    document: input?.document ?? {
      id: "doc-1",
      displayName: "Initial",
      markdown: "initial body",
      version: "opaque-v1",
    },
    save: async (request) => {
      requests.push(request)
      return input?.save?.(request) ?? { ok: true, version: `opaque-v${requests.length + 1}` }
    },
    recovery: createRecoveryDraftStore(storage),
    schedule: scheduler.schedule,
    now: () => 10_000,
    autosaveDelay: 50,
    retryDelays: input?.retryDelays ?? [100, 200],
    reportError: (error) => reportedErrors.push(error),
  })
  return { controller, requests, scheduler, storage, reportedErrors }
}

async function settle() {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}

describe("document persistence controller", () => {
  test("recovery drafts rewrite content on each edit without rewriting an unchanged version index", () => {
    const storage = memoryStorage()
    const setItem = storage.setItem
    let versionIndexWrites = 0
    storage.setItem = (key, value) => {
      if (key.endsWith(":versions")) versionIndexWrites++
      setItem(key, value)
    }
    const recovery = createRecoveryDraftStore(storage)
    const draft = {
      documentId: "doc-1",
      version: "opaque-v1",
      displayName: "Plan",
      markdown: "one",
      updatedAt: 1,
    }

    expect(recovery.write(draft)).toEqual({ ok: true, value: undefined })
    expect(recovery.write({ ...draft, markdown: "two", updatedAt: 2 })).toEqual({ ok: true, value: undefined })
    expect(versionIndexWrites).toBe(1)
    expect(recovery.read("doc-1", "opaque-v1")).toEqual({
      ok: true,
      value: { ...draft, markdown: "two", updatedAt: 2 },
    })
  })

  test("EC-B1 serializes rapid alternating display-name and Markdown edits through one version", async () => {
    const test = setup()
    test.controller.editDisplayName("One")
    test.controller.editMarkdown("body one")
    test.controller.editDisplayName("Two")
    expect(test.scheduler.delays()).toEqual([50])

    test.scheduler.runNext()
    await settle()

    expect(test.requests).toEqual([{ displayName: "Two", markdown: "body one", expectedVersion: "opaque-v1" }])
    expect(test.controller.snapshot()).toMatchObject({ status: "saved", expectedVersion: "opaque-v2" })
  })

  test("EC-B2 preserves the stale tab draft and current disk value on conflict", async () => {
    const test = setup({
      save: async () => ({
        ok: false,
        kind: "conflict",
        currentVersion: "opaque-other",
        current: { displayName: "Other tab", markdown: "disk body" },
      }),
    })
    test.controller.editMarkdown("my draft")
    await test.controller.flush()

    expect(test.controller.snapshot()).toMatchObject({
      status: "conflicted",
      expectedVersion: "opaque-v1",
      draft: { displayName: "Initial", markdown: "my draft" },
      conflict: {
        currentVersion: "opaque-other",
        current: { displayName: "Other tab", markdown: "disk body" },
        draft: { displayName: "Initial", markdown: "my draft" },
      },
    })
    expect(test.scheduler.delays()).toEqual([])
  })

  test("EC-B4 coalesces edits made during an in-flight save and applies responses in order", async () => {
    const first = deferred<SaveResponse>()
    const test = setup({
      save: (request) =>
        request.markdown === "first" ? first.promise : Promise.resolve({ ok: true, version: "opaque-v3" }),
    })
    test.controller.editMarkdown("first")
    test.scheduler.runNext()
    await settle()
    test.controller.editDisplayName("latest title")
    test.controller.editMarkdown("latest")
    expect(test.requests).toHaveLength(1)

    first.resolve({ ok: true, version: "opaque-v2" })
    await settle()

    expect(test.requests).toEqual([
      { displayName: "Initial", markdown: "first", expectedVersion: "opaque-v1" },
      { displayName: "latest title", markdown: "latest", expectedVersion: "opaque-v2" },
    ])
    expect(test.controller.snapshot()).toMatchObject({ status: "saved", expectedVersion: "opaque-v3" })
  })

  test("EC-B5 uses the opaque content version unchanged after a simulated restart", async () => {
    const storage = memoryStorage()
    const crashed = setup({ storage })
    crashed.controller.editMarkdown("survives restart")

    const restarted = setup({ storage })
    expect(restarted.controller.snapshot()).toMatchObject({
      status: "dirty",
      expectedVersion: "opaque-v1",
      draft: { markdown: "survives restart" },
      restoredRecoveryDraft: true,
    })
    await restarted.controller.flush()
    expect(restarted.requests[0]?.expectedVersion).toBe("opaque-v1")
  })

  test("transient save failures retry with capped visible backoff", async () => {
    let attempt = 0
    const test = setup({
      save: async () => {
        attempt++
        if (attempt < 3) throw new Error(`offline ${attempt}`)
        return { ok: true, version: "opaque-v2" }
      },
      retryDelays: [100, 200],
    })
    test.controller.editMarkdown("draft")
    await test.controller.flush()
    expect(test.controller.snapshot()).toMatchObject({ status: "failed", retryAttempt: 1, retryAt: 10_100 })
    expect(test.scheduler.delays()).toEqual([100])

    test.scheduler.runNext()
    await settle()
    expect(test.controller.snapshot()).toMatchObject({ status: "failed", retryAttempt: 2, retryAt: 10_200 })
    expect(test.scheduler.delays()).toEqual([200])

    test.scheduler.runNext()
    await settle()
    expect(test.controller.snapshot()).toMatchObject({ status: "saved", retryAttempt: 0, expectedVersion: "opaque-v2" })
  })

  test("EC-B7 close flush preserves a failed draft and restored recovery survives a crash", async () => {
    const storage = memoryStorage()
    const failed = setup({
      storage,
      save: async () => {
        throw new Error("disk full")
      },
    })
    failed.controller.editMarkdown("unsaved")
    const outcome = await failed.controller.flushOnClose()
    expect(outcome.status).toBe("failed")
    expect(failed.controller.snapshot()).toMatchObject({ status: "failed", draft: { markdown: "unsaved" } })

    const restarted = setup({ storage })
    expect(restarted.controller.snapshot()).toMatchObject({
      status: "dirty",
      draft: { markdown: "unsaved" },
      restoredRecoveryDraft: true,
    })
  })

  test("EC-B7 restores a stale-base recovery draft as a conflict after disk advances", () => {
    const storage = memoryStorage()
    const crashed = setup({ storage })
    crashed.controller.editMarkdown("human draft from v1")

    const restarted = setup({
      storage,
      document: {
        id: "doc-1",
        displayName: "Disk v2",
        markdown: "other tab body",
        version: "opaque-v2",
      },
    })

    expect(restarted.controller.snapshot()).toMatchObject({
      status: "conflicted",
      expectedVersion: "opaque-v1",
      draft: { displayName: "Initial", markdown: "human draft from v1" },
      restoredRecoveryDraft: true,
      conflict: {
        currentVersion: "opaque-v2",
        current: { displayName: "Disk v2", markdown: "other tab body" },
        draft: { displayName: "Initial", markdown: "human draft from v1" },
      },
    })
  })

  test("flush during an in-flight save promotes the newest edit immediately and settles after it", async () => {
    const first = deferred<SaveResponse>()
    const test = setup({
      save: (request) =>
        request.markdown === "first" ? first.promise : Promise.resolve({ ok: true, version: "opaque-v3" }),
    })
    test.controller.editMarkdown("first")
    test.scheduler.runNext()
    await settle()
    test.controller.editMarkdown("second")
    let settled = false
    const flushed = test.controller.flush().then((result) => {
      settled = true
      return result
    })
    await settle()
    expect(settled).toBe(false)

    first.resolve({ ok: true, version: "opaque-v2" })
    await expect(flushed).resolves.toMatchObject({ status: "saved", expectedVersion: "opaque-v3" })
    expect(test.requests).toHaveLength(2)
  })

  test("retry gives up visibly after the configured cap and explicit retry remains actionable", async () => {
    let failing = true
    const test = setup({
      save: async () => {
        if (failing) throw new Error("read only")
        return { ok: true, version: "opaque-v2" }
      },
      retryDelays: [100],
    })
    test.controller.editMarkdown("draft")
    await test.controller.flush()
    test.scheduler.runNext()
    await settle()
    expect(test.controller.snapshot()).toMatchObject({ status: "failed", retryAttempt: 2, retryAt: undefined })
    expect(test.scheduler.delays()).toEqual([])

    failing = false
    await expect(test.controller.retry()).resolves.toMatchObject({ status: "saved" })
  })

  test("blur and content-consuming action entrypoints flush immediately", async () => {
    const test = setup()
    test.controller.editMarkdown("blurred")
    await expect(test.controller.flushOnBlur()).resolves.toMatchObject({ status: "saved" })
    test.controller.editDisplayName("Before export")
    await expect(test.controller.flushBeforeAction()).resolves.toMatchObject({ status: "saved" })
    expect(test.requests).toHaveLength(2)
  })

  test("conflict recovery exposes reload, save-as-copy draft, and confirmed overwrite", async () => {
    let conflict = true
    const test = setup({
      save: async () =>
        conflict
          ? {
              ok: false,
              kind: "conflict",
              currentVersion: "opaque-v2",
              current: { displayName: "Disk", markdown: "disk" },
            }
          : { ok: true, version: "opaque-v3" },
    })
    test.controller.editMarkdown("human")
    await test.controller.flush()
    expect(test.controller.draftForSaveAsCopy()).toEqual({ displayName: "Initial", markdown: "human" })

    conflict = false
    await expect(test.controller.confirmOverwrite()).resolves.toMatchObject({ status: "saved" })
    expect(test.requests[1]?.expectedVersion).toBe("opaque-v2")

    const reload = setup({
      save: async () => ({
        ok: false,
        kind: "conflict",
        currentVersion: "opaque-v2",
        current: { displayName: "Disk", markdown: "disk" },
      }),
    })
    reload.controller.editMarkdown("human")
    await reload.controller.flush()
    reload.controller.reloadFromConflict()
    expect(reload.controller.snapshot()).toMatchObject({
      status: "idle",
      expectedVersion: "opaque-v2",
      draft: { displayName: "Disk", markdown: "disk" },
    })
  })

  test("recovery storage failures are exposed instead of silently caught", () => {
    const storage: RecoveryDraftStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded")
      },
      removeItem: () => undefined,
    }
    const test = setup({ storage })
    test.controller.editMarkdown("draft")
    expect(test.controller.snapshot().recoveryError).toBeInstanceOf(Error)
    expect(test.controller.snapshot().status).toBe("dirty")
  })

  test("recovery draft is cleared only after the latest draft saves successfully", async () => {
    const storage = memoryStorage()
    const pending = deferred<SaveResponse>()
    const test = setup({ storage, save: () => pending.promise })
    test.controller.editMarkdown("draft")
    expect(storage.values.size).toBeGreaterThan(0)
    const flushed = test.controller.flush()
    expect(storage.values.size).toBeGreaterThan(0)
    pending.resolve({ ok: true, version: "opaque-v2" })
    await flushed
    expect(storage.values.size).toBe(0)
  })

  test("throwing subscribers are exposed without hanging successful, failed, or conflicted flushes", async () => {
    const responses: Array<() => Promise<SaveResponse>> = [
      async () => ({ ok: true, version: "opaque-v2" }),
      async () => {
        throw new Error("disk full")
      },
      async () => ({
        ok: false,
        kind: "conflict",
        currentVersion: "opaque-v3",
        current: { displayName: "Disk", markdown: "disk" },
      }),
    ]
    const test = setup({ save: () => responses.shift()!() })
    test.controller.subscribe((snapshot) => {
      if (["saved", "failed", "conflicted"].includes(snapshot.status)) throw new Error(`listener ${snapshot.status}`)
    })

    test.controller.editMarkdown("save")
    await expect(test.controller.flush()).resolves.toMatchObject({ status: "saved" })
    expect(test.controller.snapshot().listenerError).toEqual(new Error("listener saved"))

    test.controller.editMarkdown("fail")
    await expect(test.controller.flush()).resolves.toMatchObject({ status: "failed" })
    expect(test.controller.snapshot().listenerError).toEqual(new Error("listener failed"))

    await test.controller.retry()
    expect(test.controller.snapshot()).toMatchObject({ status: "conflicted" })
    expect(test.controller.snapshot().listenerError).toEqual(new Error("listener conflicted"))
    expect(test.reportedErrors).toEqual([
      new Error("listener saved"),
      new Error("listener failed"),
      new Error("listener conflicted"),
    ])
  })

  test("external rereads refresh a clean controller and conflict a dirty controller", () => {
    const clean = setup()
    clean.controller.applyExternalChange({
      displayName: "External",
      markdown: "external body",
      version: "opaque-v2",
    })
    expect(clean.controller.snapshot()).toMatchObject({
      status: "idle",
      expectedVersion: "opaque-v2",
      draft: { displayName: "External", markdown: "external body" },
    })

    const dirty = setup()
    dirty.controller.editMarkdown("human")
    dirty.controller.applyExternalChange({
      displayName: "External",
      markdown: "external body",
      version: "opaque-v2",
    })
    expect(dirty.controller.snapshot()).toMatchObject({
      status: "conflicted",
      expectedVersion: "opaque-v1",
      draft: { displayName: "Initial", markdown: "human" },
      conflict: {
        currentVersion: "opaque-v2",
        current: { displayName: "External", markdown: "external body" },
      },
    })
    expect(dirty.scheduler.delays()).toEqual([])
  })

  test("an unchanged focus reread does not turn a dirty draft into a conflict", () => {
    const test = setup()
    test.controller.editMarkdown("human")
    const before = test.controller.snapshot()
    test.controller.applyExternalChange({
      displayName: "Initial",
      markdown: "initial body",
      version: "opaque-v1",
    })
    expect(test.controller.snapshot()).toMatchObject({
      status: "dirty",
      expectedVersion: "opaque-v1",
      draft: { displayName: "Initial", markdown: "human" },
      conflict: undefined,
    })
    expect(test.controller.snapshot().draft).toEqual(before.draft)
    expect(test.scheduler.delays()).toEqual([50])
  })

  test("an identical-byte rewrite advances the base token without conflicting a dirty draft", () => {
    const test = setup()
    test.controller.editMarkdown("human")
    test.controller.applyExternalChange({
      displayName: "Initial",
      markdown: "initial body",
      version: "opaque-v1-new-mtime",
    })
    expect(test.controller.snapshot()).toMatchObject({
      status: "dirty",
      expectedVersion: "opaque-v1-new-mtime",
      draft: { displayName: "Initial", markdown: "human" },
      conflict: undefined,
    })
    expect(test.scheduler.delays()).toEqual([50])
  })

  test("an in-flight success cannot erase a conflict discovered by an external reread", async () => {
    const pending = deferred<SaveResponse>()
    const test = setup({ save: () => pending.promise })
    test.controller.editMarkdown("human")
    test.scheduler.runNext()
    await settle()

    test.controller.applyExternalChange({
      displayName: "External",
      markdown: "external body",
      version: "opaque-v2",
    })
    pending.resolve({ ok: true, version: "opaque-save-result" })
    await settle()

    expect(test.controller.snapshot()).toMatchObject({
      status: "conflicted",
      draft: { displayName: "Initial", markdown: "human" },
      conflict: {
        currentVersion: "opaque-v2",
        current: { displayName: "External", markdown: "external body" },
      },
    })
  })

  test("a repaired recovery index is cleared after save and does not resurrect the draft", async () => {
    const storage = memoryStorage()
    storage.values.set("claxedo:document-recovery:doc-1:versions", "not json")
    const controller = setup({ storage })
    controller.controller.editMarkdown("draft")
    await controller.controller.flush()

    const restarted = setup({
      storage,
      document: {
        id: "doc-1",
        displayName: "Initial",
        markdown: "draft",
        version: "opaque-v2",
      },
    })
    expect(storage.values.size).toBe(0)
    expect(restarted.controller.snapshot()).toMatchObject({ status: "idle", restoredRecoveryDraft: false })
  })

  test("a delayed save conflict cannot regress a newer external reread", async () => {
    const pending = deferred<SaveResponse>()
    const test = setup({ save: () => pending.promise })
    test.controller.editMarkdown("human")
    test.scheduler.runNext()
    await settle()
    test.controller.applyExternalChange({ displayName: "Disk v2", markdown: "v2", version: "opaque-v2" })
    test.controller.applyExternalChange({ displayName: "Disk v3", markdown: "v3", version: "opaque-v3" })

    pending.resolve({
      ok: false,
      kind: "conflict",
      currentVersion: "opaque-v2",
      current: { displayName: "Disk v2", markdown: "v2" },
    })
    await settle()

    expect(test.controller.snapshot()).toMatchObject({
      status: "conflicted",
      conflict: {
        currentVersion: "opaque-v3",
        current: { displayName: "Disk v3", markdown: "v3" },
      },
    })
  })

  test("an SSE self-event before its matching save response reconciles without a false conflict", async () => {
    const pending = deferred<SaveResponse>()
    const test = setup({ save: () => pending.promise })
    test.controller.editMarkdown("human")
    test.scheduler.runNext()
    await settle()
    test.controller.applyExternalChange({
      displayName: "Initial",
      markdown: "human",
      version: "opaque-v2",
    })

    pending.resolve({ ok: true, version: "opaque-v2" })
    await settle()

    expect(test.controller.snapshot()).toMatchObject({
      status: "saved",
      expectedVersion: "opaque-v2",
      conflict: undefined,
      draft: { displayName: "Initial", markdown: "human" },
    })
  })
})
