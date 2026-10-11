import { expect, test } from "bun:test"
import type { IPty } from "@lydell/node-pty"
import { closeNativeTerminal } from "./native-close"

function windowsTerminal(shellPid: number) {
  const killed: number[] = []
  const agent = { _getConsoleProcessList: (): Promise<number[]> => Promise.resolve([shellPid]) }
  const terminal = {
    _agent: agent,
    kill: () => { void agent._getConsoleProcessList().then((pids) => killed.push(...pids)) },
  }
  return { terminal: terminal as unknown as IPty, agent, killed }
}

test("closing a Windows terminal kills no console process by pid", async () => {
  const { terminal, agent, killed } = windowsTerminal(4242)

  closeNativeTerminal(terminal, "win32")

  expect(await agent._getConsoleProcessList()).toEqual([])
  expect(killed).toEqual([])
})

test("a Windows terminal whose agent cannot be reached is not killed by pid", () => {
  let kills = 0
  const terminal = { kill: () => { kills++ } } as unknown as IPty

  expect(() => closeNativeTerminal(terminal, "win32")).toThrow("_getConsoleProcessList")
  expect(kills).toBe(0)
})

test("a POSIX terminal is closed through its own kill", () => {
  let kills = 0
  const terminal = { kill: () => { kills++ } } as unknown as IPty

  closeNativeTerminal(terminal, "darwin")

  expect(kills).toBe(1)
})
