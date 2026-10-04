import { expect } from "@playwright/test"
import type { SignedStack } from "./signed-stack"

type Device = { readonly host_id: string }

function devicesUrl(signed: SignedStack, path = "") {
  return `${signed.hosted.workerUrl}/api/claxedo/remote-access/devices${path}`
}

export async function ownerDevices(signed: SignedStack): Promise<readonly Device[]> {
  const listed = await signed.owner.transport({ method: "GET", url: devicesUrl(signed), headers: {} })
  return (JSON.parse(listed.body) as { devices: Device[] }).devices
}

export async function revokeOwnerMachines(signed: SignedStack) {
  for (const device of await ownerDevices(signed)) {
    const revoked = await signed.owner.transport({ method: "DELETE", url: devicesUrl(signed, `/${device.host_id}`), headers: {} })
    expect(revoked.status, revoked.body).toBe(200)
  }
}

export async function servingMachineName(url: string): Promise<string> {
  const response = await fetch(new URL("/api/claxedo/bootstrap", url))
  expect(response.status).toBe(200)
  const name = ((await response.json()) as { host?: { name?: string } }).host?.name
  expect(name).toBeTruthy()
  return name ?? ""
}
