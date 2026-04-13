import { getCredentialByProvider, resolveSecret } from "../../credentials/registry"
import type { SandboxNetworkPolicy } from "../../network/resolve"
import type { SandboxHandle } from "./handle"
import type { SandboxConfig, SandboxProviderID } from "../types"

export type SandboxNetCap = "none" | "host" | "cidr" | "mixed"

export type SandboxCapabilities = {
  attach: boolean
  labels: boolean
  net: SandboxNetCap
  pool: boolean
  restart: boolean
}

export type SandboxField = {
  key: string
  label: string
  secret?: boolean
}

export type SandboxAcquireInput = {
  cfg?: SandboxConfig
  workspaceId: string
  projectId: string
  net?: SandboxNetworkPolicy
}

export type SandboxAcquireSnapshotInput = SandboxAcquireInput & {
  snapshotId: string
}

export type SandboxAcquireImageInput = SandboxAcquireInput & {
  imageId: string
}

export type SandboxAttachInput = {
  cfg?: SandboxConfig
  sandboxId: string
}

function missing(net: SandboxNetworkPolicy, mode: SandboxNetCap) {
  if (mode === "mixed") return []
  if (mode === "cidr") {
    return net.rules.filter((item) => item.cidrs.length === 0).map((item) => item.target)
  }
  if (mode === "host") {
    return net.rules.filter((item) => item.hosts.length === 0).map((item) => item.target)
  }
  return net.rules.map((item) => item.target)
}

export abstract class SandboxProvider<Auth> {
  constructor(
    readonly id: SandboxProviderID,
    readonly label: string,
    readonly fields: SandboxField[],
    readonly cap: SandboxCapabilities,
  ) {}

  read(cfg?: SandboxConfig) {
    return this.sync(cfg)
  }

  configured(cfg?: SandboxConfig) {
    return !!this.sync(cfg) || !!getCredentialByProvider(this.id)
  }

  async managed(): Promise<Auth | undefined> {
    const secret = await resolveSecret(this.id)
    if (!secret) return
    return this.parse(secret)
  }

  async auth(cfg?: SandboxConfig): Promise<Auth | undefined> {
    return this.sync(cfg) ?? this.managed()
  }

  assert(net?: SandboxNetworkPolicy) {
    if (!net || net.mode === "allow-all") return
    const miss = missing(net, this.cap.net)
    if (miss.length === 0) return
    throw new Error(`Sandbox provider ${this.id} cannot enforce restricted policy for: ${miss.join(", ")}`)
  }

  async attach(_input: SandboxAttachInput): Promise<SandboxHandle | undefined> {
    return
  }

  async acquireFromSnapshot(_input: SandboxAcquireSnapshotInput): Promise<SandboxHandle | undefined> {
    return
  }

  async acquireFromImage(_input: SandboxAcquireImageInput): Promise<SandboxHandle | undefined> {
    return
  }

  async poolEnabled(_cfg?: SandboxConfig): Promise<boolean> {
    return false
  }

  async initPool(_cfg?: SandboxConfig): Promise<void> {}

  startPoolMonitor(): void {}

  shutdown(): void {}

  released(): void {}

  protected abstract sync(cfg?: SandboxConfig): Auth | undefined
  protected abstract parse(secret: string): Auth | undefined
  abstract acquire(input: SandboxAcquireInput): Promise<SandboxHandle>
}
