/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createCapabilities } from "./capabilities"
import type { BootstrapDeclaration } from "./wire/placements"

const daemon: BootstrapDeclaration = { serverKind: "daemon", issuesSessions: false, documents: true, connections: false, hostAggregate: true, machineName: "Ada's Mac" }
const worker: BootstrapDeclaration = { serverKind: "hosted", issuesSessions: true, documents: false, connections: true, hostAggregate: false }

function declared(declaration: BootstrapDeclaration, hostedAccount: boolean) {
  return createRoot((dispose) => {
    const capabilities = createCapabilities({ hostedAccount })
    capabilities.declare(declaration)
    const value = capabilities.value()
    dispose()
    return value
  })
}

test("capabilities: cloud features belong to the scope with a hosted account, whichever server serves the app, and issuing sessions is the declaration's own fact", () => {
  expect(declared(daemon, true)).toMatchObject({ issuesSessions: false, features: { cloud: true }, servingMachine: { name: "Ada's Mac" } })
  expect(declared(daemon, false)).toMatchObject({ issuesSessions: false, features: { cloud: false } })
  expect(declared(worker, true)).toMatchObject({ issuesSessions: true, features: { cloud: true }, servingMachine: undefined })
  expect(declared(worker, false)).toMatchObject({ issuesSessions: true, features: { cloud: false } })
})
