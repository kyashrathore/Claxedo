import { describe, expect, test, vi } from "vitest"
import { runUpdate } from "./session-actions.logic"

describe("runUpdate", () => {
  test("calls sdk update with its owning object so patch-backed methods keep their context", async () => {
    const patch = vi.fn().mockResolvedValue({})
    const session = {
      client: { patch },
      update(input: unknown) {
        return this.client.patch(input)
      },
    }
    await runUpdate(session, {
      directory: "/ws/main",
      sessionID: "ses_1",
      time: { archived: Date.now() },
    })

    expect(patch).toHaveBeenCalledWith({
      directory: "/ws/main",
      sessionID: "ses_1",
      time: { archived: expect.any(Number) },
    })
  })

  test("would fail if the update method were passed around unbound", async () => {
    const session = {
      client: { patch: vi.fn().mockResolvedValue({}) },
      update(input: unknown) {
        return this.client.patch(input)
      },
    }

    await expect(
      Promise.resolve().then(() =>
        session.update.call(undefined, {
          directory: "/ws/main",
          sessionID: "ses_1",
          time: { archived: Date.now() },
        }),
      ),
    ).rejects.toThrow(/client|patch/)
  })
})
