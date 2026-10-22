/// <reference types="bun" />
import { expect, test } from "bun:test"
import { ServerError } from "@/server"
import { agentsNote } from "./agents"
import type { DomainTranslate } from "@/i18n"
import type { TerminalKey } from "./i18n"

const t: DomainTranslate<TerminalKey> = (key, params) => [key, ...Object.values(params ?? {})].join(" ")
const settled = { isError: false, isPending: false }
const facts = (agents = settled, wakeProgress?: string) => ({ name: "main", wakeProgress, agents })

test("the terminal creator says why a workspace's agents are missing: asleep, waking, or a failed wake with its reason; a workspace on an older image serves its agents", () => {
  const refusal = new ServerError({ class: "conflict", message: "No capacity" })
  expect(agentsNote(t, { kind: "asleep" }, facts())).toBe("terminal.creator.agentsAsleep main")
  expect(agentsNote(t, { kind: "outdated" }, facts())).toBeUndefined()
  expect(agentsNote(t, { kind: "outdated" }, facts({ isError: false, isPending: true }))).toBe("terminal.creator.agentsLoading")
  expect(agentsNote(t, { kind: "wakeFailed", error: refusal }, facts())).toBe("terminal.creator.agentsWakeFailed main No capacity")
  expect(agentsNote(t, { kind: "waking" }, facts())).toBe("terminal.creator.waking main")
  expect(agentsNote(t, { kind: "waking", bootMode: "resume" }, facts(settled, "Resuming the machine · 12s"))).toBe("terminal.creator.wakingProgress main Resuming the machine · 12s")
  expect(agentsNote(t, { kind: "waking", bootMode: "cold-start" }, facts(settled, "Starting the machine · 3s"))).toBe("terminal.creator.startingProgress main Starting the machine · 3s")
  expect(agentsNote(t, { kind: "waking", followed: true }, facts())).toBe("terminal.creator.startingWorkspace main")
  expect(agentsNote(t, { kind: "waking", bootMode: "resume", followed: true }, facts())).toBe("terminal.creator.waking main")
  expect(agentsNote(t, { kind: "live" }, facts({ isError: false, isPending: true }))).toBe("terminal.creator.agentsLoading")
  expect(agentsNote(t, { kind: "live" }, facts({ isError: true, isPending: false }))).toBe("terminal.creator.agentsFailed")
  expect(agentsNote(t, { kind: "live" }, facts())).toBeUndefined()
})
