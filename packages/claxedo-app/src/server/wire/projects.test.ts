/// <reference types="bun" />
import { expect, test } from "bun:test"
import { oneProjectFromWire } from "./projects"

const wire = (extra: object) => ({ project: { id: "prj_1", name: "t3code", directory: "/work/t3code", available: false, created_at: 1, updated_at: 2, ...extra } })

test("a project whose folder is gone carries the folder and the remote it is recloned from", () => {
  const project = oneProjectFromWire(wire({ missingCheckout: { directory: "/work/t3code", remote: "https://github.com/acme/t3code.git" } }))
  expect(project.missingCheckout).toEqual({ directory: "/work/t3code", remote: "https://github.com/acme/t3code.git" })
})

test("a missing folder with no recorded remote carries no remote, and a present folder carries nothing", () => {
  expect(oneProjectFromWire(wire({ missingCheckout: { directory: "/work/t3code", remote: null } })).missingCheckout).toEqual({ directory: "/work/t3code" })
  expect(oneProjectFromWire(wire({ available: true })).missingCheckout).toBeUndefined()
})
