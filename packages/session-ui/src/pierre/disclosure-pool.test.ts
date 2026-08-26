import { expect, test } from "bun:test"
import { createDisclosurePool } from "./disclosure-pool"

test("terminates exactly once after the final disclosure closes", async () => {
  let created = 0
  let initialized = 0
  let terminated = 0
  const registry = createDisclosurePool(() => {
    created += 1
    return {
      async initialize() {
        initialized += 1
      },
      terminate() {
        terminated += 1
      },
    }
  })

  const first = registry.acquire()
  const second = registry.acquire()
  first.release()
  await Promise.resolve()
  expect(registry.inspect()).toEqual({ leases: 1, started: true })
  expect(terminated).toBe(0)
  second.release()
  await Promise.resolve()
  expect(registry.inspect()).toEqual({ leases: 0, started: false })
  expect({ created, initialized, terminated }).toEqual({ created: 1, initialized: 2, terminated: 1 })
})

test("rapid reopen supersedes pending idle termination", async () => {
  let terminated = 0
  const registry = createDisclosurePool(() => ({
    async initialize() {},
    terminate() {
      terminated += 1
    },
  }))

  const first = registry.acquire()
  first.release()
  const reopened = registry.acquire()
  await Promise.resolve()
  expect(registry.inspect()).toEqual({ leases: 1, started: true })
  expect(terminated).toBe(0)
  reopened.release()
  await Promise.resolve()
  expect(terminated).toBe(1)
})
