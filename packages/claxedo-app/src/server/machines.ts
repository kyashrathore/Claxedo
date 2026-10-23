import type { QueryClient } from "@tanstack/solid-query"
import { readArray } from "@claxedo/helpers/readers"
import type { HostedAccount } from "./account"
import { ServerError, toAppError } from "./errors"
import { fetchQuery } from "./fetch-query"
import { isRecord } from "@claxedo/helpers/guards"
import type { Machine, MachineEnrollment, MachineProbe, MintedInvitation, MintedPairing, Pairing } from "./machine-types"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FetchQuery } from "./types"
import type { Workspaces } from "./workspaces"
import { servingMachineOf } from "./capabilities"
import { machinesFromDevices, RUNTIME_PROBE_PATH, runtimeProbeFromWire } from "./wire/machines"
import { mintedPairingFromWire, pairingFromWire, pairingRequestsFromWire } from "./wire/pairings"
import { mintedInvitationFromWire } from "./wire/invitations"

export type MachinesApi = {
  readonly recheck: () => Promise<readonly Machine[]>
  readonly pause: (enrollment: MachineEnrollment) => Promise<void>
  readonly resume: (enrollment: MachineEnrollment) => Promise<void>
  readonly remove: (enrollment: MachineEnrollment) => Promise<void>
  readonly rename: (enrollment: MachineEnrollment, name: string) => Promise<void>
  readonly setRoots: (enrollment: MachineEnrollment, roots: readonly string[]) => Promise<void>
  readonly probe: (enrollment: MachineEnrollment) => Promise<MachineProbe>
  readonly pair: () => Promise<MintedPairing>
  readonly approve: (pairingId: string, name: string | undefined) => Promise<void>
  readonly deny: (pairingId: string) => Promise<void>
  readonly cancelPairings: () => Promise<void>
  readonly invite: (server: ServerInvitation) => Promise<MintedInvitation>
}

export type ServerInvitation = { readonly name: string; readonly folder: string }

async function accountDevices(account: HostedAccount | undefined): Promise<readonly unknown[]> {
  return account ? (readArray(await account.run("machines.list"), "devices") ?? []) : []
}

async function loadMachines(workspaces: Workspaces, account: HostedAccount | undefined): Promise<readonly Machine[]> {
  const [{ declaration }, devices] = await Promise.all([workspaces.load(), accountDevices(account)])
  const enrolled = machinesFromDevices(devices, declaration.enrollmentId)
  const serving = servingMachineOf(declaration)
  if (!serving) return enrolled
  const listed = enrolled.find((machine) => machine.isThisMachine)
  if (listed) return [{ ...listed, online: true }, ...enrolled.filter((machine) => machine !== listed)]
  return [{ ...serving, online: true, isThisMachine: true, enrolled: serving.id !== undefined }, ...enrolled]
}

function signedIn(account: HostedAccount | undefined, operation: string): HostedAccount {
  if (!account) throw new ServerError({ class: "invalid", message: `${operation} needs a signed-in account` })
  return account
}

async function loadPairing(account: HostedAccount | undefined, pairingId: string): Promise<Pairing> {
  const answer = await signedIn(account, "machines.pairing").run("machines.pairing", { pairingId })
  const pairing = pairingFromWire(isRecord(answer) ? answer.pairing : undefined)
  if (!pairing) throw new ServerError({ class: "internal", message: "The pairing answer is not one this app can read" })
  return pairing
}

async function loadPairingRequests(account: HostedAccount | undefined): Promise<readonly Pairing[]> {
  return account ? pairingRequestsFromWire(readArray(await account.run("machines.requests"), "requests") ?? []) : []
}

export function machineQueries(transport: Transport, workspaces: Workspaces, account: HostedAccount | undefined) {
  const server = transport.serverUrl
  return {
    list: (): FetchQuery<readonly Machine[]> => fetchQuery(queryKeys.machines(server), () => loadMachines(workspaces, account)),
    pairing: (pairingId: string): FetchQuery<Pairing> => fetchQuery(queryKeys.pairing(server, pairingId), () => loadPairing(account, pairingId)),
    pairingRequests: (): FetchQuery<readonly Pairing[]> => fetchQuery(queryKeys.pairingRequests(server), () => loadPairingRequests(account)),
  }
}

async function probeRuntime(transport: Transport, enrollment: MachineEnrollment): Promise<MachineProbe> {
  const [workspaceId] = enrollment.servingWorkspaceIds
  if (!workspaceId) return { kind: "servesNothing" }
  try {
    return runtimeProbeFromWire(await transport.runtimeJson({ directory: `workspace:${workspaceId}`, workspaceId, remote: true }, RUNTIME_PROBE_PATH))
  } catch (error) {
    return { kind: "unreachable", error: toAppError(error) }
  }
}

async function invalidateMachinePlacements(queryClient: QueryClient, server: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.machines(server) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap(server) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.accountCatalog(server) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.placements(server) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projects(server) }),
  ])
}

function enrollmentChanges(queryClient: QueryClient, server: string, account: HostedAccount | undefined): Pick<MachinesApi, "rename" | "setRoots"> {
  return {
    rename: async (enrollment, name) => {
      await signedIn(account, "machines.rename").run("machines.rename", { hostId: enrollment.hostId, displayName: name })
      await invalidateMachinePlacements(queryClient, server)
    },
    setRoots: async (enrollment, roots) => {
      await signedIn(account, "machines.setRoots").run("machines.setRoots", { enrollmentId: enrollment.enrollmentId, roots: [...roots] })
      await invalidateMachinePlacements(queryClient, server)
    },
  }
}

function pairingAnswers(queryClient: QueryClient, server: string, account: HostedAccount | undefined): Pick<MachinesApi, "pair" | "approve" | "deny" | "cancelPairings"> {
  return {
    pair: async () => {
      const minted = mintedPairingFromWire(await signedIn(account, "machines.pair").run("machines.pair"))
      if (!minted) throw new ServerError({ class: "internal", message: "The pairing code answer is not one this app can read" })
      return minted
    },
    approve: async (pairingId, name) => {
      await signedIn(account, "machines.approve").run("machines.approve", { pairingId, ...(name ? { displayName: name } : {}) })
      await invalidateMachinePlacements(queryClient, server)
    },
    deny: async (pairingId) => {
      await signedIn(account, "machines.deny").run("machines.deny", { pairingId })
      await queryClient.invalidateQueries({ queryKey: queryKeys.machines(server) })
    },
    cancelPairings: async () => {
      if (account) await account.run("machines.cancelPairings")
    },
  }
}

async function mintInvitation(account: HostedAccount | undefined, server: ServerInvitation): Promise<MintedInvitation> {
  const answer = await signedIn(account, "machines.invite").run("machines.invite", { folder: server.folder, ...(server.name ? { displayName: server.name } : {}) })
  const minted = mintedInvitationFromWire(answer)
  if (!minted) throw new ServerError({ class: "internal", message: "The invitation answer is not one this app can read" })
  return minted
}

export function createMachinesApi(transport: Transport, queryClient: QueryClient, workspaces: Workspaces, account: HostedAccount | undefined): MachinesApi {
  const server = transport.serverUrl
  const change = async (operation: "machines.pause" | "machines.resume" | "machines.remove", enrollment: MachineEnrollment) => {
    await signedIn(account, operation).run(operation, { hostId: enrollment.hostId })
    await queryClient.invalidateQueries({ queryKey: queryKeys.machines(server) })
  }
  const recheck = async () => {
    await queryClient.cancelQueries({ queryKey: queryKeys.machines(server) })
    return queryClient.fetchQuery({ ...machineQueries(transport, workspaces, account).list(), staleTime: 0, retry: false, networkMode: "always" })
  }
  return {
    recheck,
    pause: (enrollment) => change("machines.pause", enrollment),
    resume: (enrollment) => change("machines.resume", enrollment),
    remove: async (enrollment) => {
      await change("machines.remove", enrollment)
      await queryClient.invalidateQueries({ queryKey: queryKeys.accountCatalog(server) })
    },
    probe: (enrollment) => probeRuntime(transport, enrollment),
    ...enrollmentChanges(queryClient, server, account),
    ...pairingAnswers(queryClient, server, account),
    invite: (invited) => mintInvitation(account, invited),
  }
}
