import { describe, expect, test } from "bun:test"
import { shape } from "./process-events"

describe("shape", () => {
  test("maps runtime process events to directory-scoped global events", () => {
    expect(shape({
      type: "process.status",
      directory: "/ws/main",
      configId: "proc_1",
      status: "running",
    })).toEqual({
      directory: "/ws/main",
      payload: {
        type: "process.status",
        properties: {
          configId: "proc_1",
          status: "running",
        },
      },
    })
  })

  test("ignores non-process events", () => {
    expect(shape({
      type: "pty.deleted",
      id: "pty_1",
    })).toBeUndefined()
  })
})
