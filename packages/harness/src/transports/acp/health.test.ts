import { expect, test } from "bun:test"
import { AcpConnectionHealth } from "./health"

test("disconnect during startup cannot be overwritten by late ready or failure", () => {
  const health = new AcpConnectionHealth({ now: Date.now, setTimeout, clearTimeout }, () => {})
  const generation = health.begin("session", "/repo")
  generation.disconnected()
  generation.ready()
  generation.failed(new Error("late startup failure"))
  expect(health.connection("/repo", "session").state).toBe("disconnected")
})

test("a connection with one ready session stays ready when another session's startup fails", () => {
  const health = new AcpConnectionHealth({ now: Date.now, setTimeout, clearTimeout }, () => {})
  health.begin("serving", "/repo").ready()
  health.begin("refused", "/repo").failed(new Error("Requested startup failure"))
  expect(health.connection("/repo").state).toBe("ready")
  expect(health.connection("/repo", "refused").state).toBe("failed")
})

test("a directory with no live sessions is healthy, and a forgotten session leaves nothing behind", () => {
  const health = new AcpConnectionHealth({ now: Date.now, setTimeout, clearTimeout }, () => {})
  expect(health.runtime("/repo")).toEqual({ status: "ok" })
  const generation = health.begin("closing", "/repo")
  generation.ready()
  health.forget("closing")
  expect(health.connection("/repo")).toEqual({ state: "configured", processes: [] })
  health.begin("refused", "/repo").failed(new Error("Requested startup failure"))
  expect(health.runtime("/repo")).toEqual({ status: "unavailable" })
})

test("a session nobody observes reads as its directory does, never as disconnected", () => {
  const health = new AcpConnectionHealth({ now: Date.now, setTimeout, clearTimeout }, () => {})
  expect(health.connection("/repo", "released")).toEqual({ state: "configured", processes: [] })
  health.begin("serving", "/repo").ready()
  expect(health.connection("/repo", "released").state).toBe("ready")
  health.begin("released", "/repo").ready()
  health.forget("released")
  expect(health.connection("/repo", "released").state).toBe("ready")
})

test("every applied observation and forgotten session reports a change, and a fenced one does not", () => {
  let changes = 0
  const health = new AcpConnectionHealth({ now: Date.now, setTimeout, clearTimeout }, () => { changes++ })
  const first = health.begin("session", "/repo")
  first.ready()
  expect(changes).toBe(2)
  first.disconnected()
  first.ready()
  expect(changes).toBe(3)
  health.forget("session")
  health.forget("session")
  expect(changes).toBe(4)
})
