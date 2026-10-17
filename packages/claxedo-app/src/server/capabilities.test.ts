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

test("capabilities: the hosted account is the scope's own fact, while issuing sessions and creating cloud workspaces of this server's projects are the declaration's, so a signed desktop served by its daemon reads hosted facts without offering what its daemon cannot do", () => {
  expect(declared(daemon, true)).toMatchObject({ issuesSessions: false, hostedAccount: true, features: { cloud: false }, servingMachine: { name: "Ada's Mac" } })
  expect(declared(daemon, false)).toMatchObject({ issuesSessions: false, hostedAccount: false, features: { cloud: false } })
  expect(declared(worker, true)).toMatchObject({ issuesSessions: true, hostedAccount: true, features: { cloud: true }, servingMachine: undefined })
  expect(declared(worker, false)).toMatchObject({ issuesSessions: true, hostedAccount: false, features: { cloud: true } })
})
