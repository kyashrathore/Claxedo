/// <reference types="bun" />
import { expect, test } from "bun:test"
import { ServerError } from "@/server"
import { agentsNote } from "./agents"
import type { DomainTranslate } from "@/i18n"
import type { TerminalKey } from "./i18n"

const t: DomainTranslate<TerminalKey> = (key, params) => [key, ...Object.values(params ?? {})].join(" ")
const settled = { isError: false, isPending: false }

test("the terminal creator says why a workspace's agents are missing: asleep, outdated, or a failed wake with its reason", () => {
  const refusal = new ServerError({ class: "conflict", message: "No capacity" })
  expect(agentsNote(t, { kind: "asleep" }, "main", settled)).toBe("terminal.creator.agentsAsleep main")
  expect(agentsNote(t, { kind: "outdated" }, "main", settled)).toBe("terminal.creator.agentsOutdated main")
  expect(agentsNote(t, { kind: "wakeFailed", error: refusal }, "main", settled)).toBe("terminal.creator.agentsWakeFailed main No capacity")
  expect(agentsNote(t, { kind: "waking" }, "main", settled)).toBe("terminal.creator.agentsLoading")
  expect(agentsNote(t, { kind: "live" }, "main", { isError: false, isPending: true })).toBe("terminal.creator.agentsLoading")
  expect(agentsNote(t, { kind: "live" }, "main", { isError: true, isPending: false })).toBe("terminal.creator.agentsFailed")
  expect(agentsNote(t, { kind: "live" }, "main", settled)).toBeUndefined()
})
