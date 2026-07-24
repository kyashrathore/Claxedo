import { describe, expect, test } from "bun:test"
import { createCursorSdkDriver } from "./driver"
import type { AgentProcessDescriptor, AgentProcessObserver } from "../../process-observer"

describe("Cursor SDK driver", () => {
  test("serves the static Cursor model catalog before any live listing", () => {
    const driver = createCursorSdkDriver({
      lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      bindSession() {},
    } as never)

    expect(driver.peekConfigOptions("gpt-5.5")).toEqual([
      expect.objectContaining({
        id: "model",
        currentValue: "gpt-5.5",
        selectOptions: expect.arrayContaining([
          expect.objectContaining({ id: "auto" }),
          expect.objectContaining({ id: "gpt-5.5" }),
        ]),
      }),
    ])
  })

  test("keeps an SDK-only local root inferred and action-ineligible", () => {
    const descriptors: AgentProcessDescriptor[] = []
    const processObserver: AgentProcessObserver = {
      register(descriptor) {
        descriptors.push(descriptor)
        return { update: () => undefined, exit: () => undefined }
      },
    }
    const driver = createCursorSdkDriver({
      lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      processObserver,
      bindSession() {},
    } as never)
    driver.applyConfig({
      mcp: {
        local: {
          name: "local",
          source: "user",
          transport: "stdio",
          command: "node",
          args: ["secret"],
          env: { TOKEN: "secret" },
        },
      },
    })

    const handle = (driver as unknown as {
      observeAgent(directory: string, sessionId: string): { exit(input: { reason: "disposed" }): void }
    }).observeAgent("/safe/workspace", "session-safe")
    handle.exit({ reason: "disposed" })

    expect(descriptors).toMatchObject([
      {
        harnessId: "cursor",
        role: "harness",
        locality: "local-process",
        confidence: "inferred",
        capabilities: { resourceMetrics: "process", ownerActions: false },
        sessionId: "session-safe",
      },
      {
        harnessId: "cursor",
        role: "mcp",
        parentOwnerId: descriptors[0]?.ownerId,
      },
    ])
    expect(JSON.stringify(descriptors)).not.toContain("secret")
  })
})
