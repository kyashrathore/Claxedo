import { expect, type TestInfo } from "@playwright/test"
import { sendJson } from "../../../harness/e2e/harness/transport"
import { connectFolder, startConnectCli, type ConnectCli } from "./connect-cli"
import { ownerDevices } from "./machine-devices"
import type { SignedStack } from "./signed-stack"

type PairingView = { readonly stage: string; readonly workspace_id?: string; readonly host_id?: string }

export type ConnectedMachine = {
  readonly name: string
  readonly hostId: string
  readonly enrollmentId: string
  readonly home: string
  readonly folder: string
  readonly firstWorkspaceId: string
  readonly cli: ConnectCli
  readonly servedWorkspaceIds: () => Promise<readonly string[]>
  readonly close: () => Promise<void>
}

async function pairing(signed: SignedStack, pairingId: string): Promise<PairingView> {
  const body = await sendJson(signed.owner.transport, "GET", `${signed.hosted.workerUrl}/api/claxedo/host/pairings/${encodeURIComponent(pairingId)}`, undefined, "Reading the pairing")
  return (JSON.parse(body) as { pairing: PairingView }).pairing
}

async function deviceOf(signed: SignedStack, hostId: string) {
  return (await ownerDevices(signed)).find((device) => device.host_id === hostId)
}

async function servedBy(signed: SignedStack, hostId: string): Promise<readonly string[]> {
  return (await deviceOf(signed, hostId))?.serving_workspace_ids ?? []
}

export async function connectMachine(signed: SignedStack, name: string, testInfo: TestInfo): Promise<ConnectedMachine> {
  const where = await connectFolder("app")
  const minted = JSON.parse(await sendJson(signed.owner.transport, "POST", `${signed.hosted.workerUrl}/api/claxedo/host/pairings`, {}, "Minting a pairing code")) as { pairing_id: string; code: string }
  const cli = startConnectCli(signed, { code: minted.code, home: where.home, folder: where.folder })
  const close = async () => {
    await cli.stop()
    await testInfo.attach(`claxedo connect on ${name}`, { body: cli.lines().join("\n"), contentType: "text/plain" })
    await where.close()
  }
  try {
    await expect.poll(async () => (await pairing(signed, minted.pairing_id)).stage, { timeout: 60_000 }).toBe("awaiting_approval")
    await sendJson(signed.owner.transport, "POST", `${signed.hosted.workerUrl}/api/claxedo/host/pairings/${minted.pairing_id}/approve`, { displayName: name }, "Approving the machine")
    const approved = await pairing(signed, minted.pairing_id)
    const hostId = approved.host_id ?? ""
    const firstWorkspaceId = approved.workspace_id ?? ""
    await expect.poll(() => servedBy(signed, hostId), { timeout: 30_000 }).toContain(firstWorkspaceId)
    const enrollmentId = (await deviceOf(signed, hostId))?.enrollment_id ?? ""
    return { name, hostId, enrollmentId, home: where.home, folder: where.folder, firstWorkspaceId, cli, servedWorkspaceIds: () => servedBy(signed, hostId), close }
  } catch (error) {
    await close()
    throw error
  }
}
