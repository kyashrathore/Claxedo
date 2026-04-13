import type { SandboxNetworkPolicy } from "../../network/resolve"
import type { SandboxHandle } from "./handle"
import type { SandboxConfig, SandboxProviderID } from "../types"
import { SandboxSystem } from "./system"

export { type SandboxCapabilities, type SandboxField, type SandboxNetCap } from "./provider"

export const sandbox = new SandboxSystem()

export function sandboxProvider(input: string | undefined) {
  return sandbox.provider(input)
}

export function defaultSandboxProvider(cfg?: SandboxConfig) {
  return sandbox.default(cfg)
}

export function sandboxAuth<T extends SandboxProviderID>(cfg: SandboxConfig | undefined, id: T) {
  return sandbox.authSync(cfg, id)
}

export function hasSandboxAuth(cfg: SandboxConfig | undefined, id: SandboxProviderID) {
  return sandbox.hasAuth(cfg, id)
}

export async function sandboxAuthManaged<T extends SandboxProviderID>(id: T) {
  return sandbox.authManaged(id)
}

export async function sandboxAuthAsync<T extends SandboxProviderID>(cfg: SandboxConfig | undefined, id: T) {
  return sandbox.auth(cfg, id)
}

export function listSandboxProviders(cfg?: SandboxConfig) {
  return sandbox.list(cfg)
}

export function sandboxDriver(id: SandboxProviderID) {
  return sandbox.get(id)
}

export function assertNet(id: SandboxProviderID, net?: SandboxNetworkPolicy) {
  sandbox.assert(id, net)
}

export async function acquire(
  workspaceId: string,
  projectId: string,
  net?: SandboxNetworkPolicy,
  provider?: SandboxProviderID,
): Promise<SandboxHandle> {
  return sandbox.acquire(workspaceId, projectId, net, provider)
}

export async function attach(sandboxId: string, provider: SandboxProviderID) {
  return sandbox.attach(sandboxId, provider)
}

export async function acquireFromSnapshot(
  workspaceId: string,
  projectId: string,
  snapshotId: string,
  net?: SandboxNetworkPolicy,
  provider?: SandboxProviderID,
): Promise<SandboxHandle> {
  return sandbox.acquireFromSnapshot(workspaceId, projectId, snapshotId, net, provider)
}

export async function acquireFromImage(
  workspaceId: string,
  projectId: string,
  imageId: string,
  net?: SandboxNetworkPolicy,
  provider?: SandboxProviderID,
): Promise<SandboxHandle> {
  return sandbox.acquireFromImage(workspaceId, projectId, imageId, net, provider)
}

export async function release(handle: SandboxHandle) {
  return sandbox.release(handle)
}

export async function poolEnabled() {
  return sandbox.poolEnabled()
}

export async function initPool() {
  return sandbox.initPool()
}

export function startPoolMonitor() {
  return sandbox.startPoolMonitor()
}

export function shutdown() {
  return sandbox.shutdown()
}
