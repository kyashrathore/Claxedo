import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { TurnAuthorityError } from "./turn-delivery"
import { machineFailureText, workspaceMachineAccess } from "./workspace-machine"

async function toolMachineText(refusal: TurnAuthorityError, wait = false) {
  try {
    await workspaceMachineAccess(async () => { throw refusal }, { wait })
  } catch (error) {
    return machineFailureText(error)
  }
  throw new Error("the machine access answered")
}

void describe("a tool call's machine text", () => {
  void it("is one line for a refused start, with the wait folded in when the start names one", async () => {
    const refused = (message: string, retryAfterMs?: number) =>
      new TurnAuthorityError(409, "cloud_runtime_start_refused", { message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) })
    assert.equal(
      await toolMachineText(refused("The cloud workspace could not start: Boat's hourly start limit (60) is used up.", 3_600_000)),
      "The cloud workspace could not start: Boat's hourly start limit (60) is used up; try again in about 60 min.",
    )
    assert.equal(
      await toolMachineText(refused("The cloud workspace could not start: Boat returned an error.", 30_000)),
      "The cloud workspace could not start: Boat returned an error; try again in about 30 s.",
    )
    assert.equal(
      await toolMachineText(refused("The cloud workspace could not start: Boat's daily start limit (200) is used up; try again later.")),
      "The cloud workspace could not start: Boat's daily start limit (200) is used up; try again later.",
    )
  })

  void it("is one line for an asleep or starting machine", async () => {
    assert.equal(await toolMachineText(new TurnAuthorityError(409, "cloud_runtime_unavailable")), "The workspace machine is asleep; a tool call starts it.")
    assert.equal(
      await toolMachineText(new TurnAuthorityError(409, "cloud_runtime_starting", { started: true, retryAfterMs: 2_000, sinceStartMs: 0 })),
      "This tool call started the asleep workspace machine.",
    )
    assert.equal(
      await toolMachineText(new TurnAuthorityError(409, "cloud_runtime_starting", { retryAfterMs: 30_000, sinceStartMs: 35_000 }), true),
      "The workspace machine is still starting (35 s so far); call this tool again to wait up to 20 s for it.",
    )
  })
})
