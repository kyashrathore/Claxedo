import { loadUserConfig } from "../../agent-config"
import { Log } from "../../log"
import type { SandboxNetworkPolicy } from "../../network/resolve"
import type { SandboxHandle } from "./handle"
import type { SandboxConfig, SandboxProviderID } from "../types"
import { sandbox_provider_ids } from "../types"
import { CloudflareProvider, DaytonaProvider, ModalProvider, VercelProvider } from "./providers"
import type { SandboxProvider } from "./provider"

const log = Log.create({ service: "sandbox" })

export class SandboxSystem {
  private daytona = new DaytonaProvider()
  private items: Record<SandboxProviderID, SandboxProvider<any>> = {
    daytona: this.daytona,
    modal: new ModalProvider(),
    vercel: new VercelProvider(),
    cloudflare: new CloudflareProvider(),
  }

  provider(input: string | undefined): SandboxProviderID | undefined {
    if (input && (sandbox_provider_ids as readonly string[]).includes(input)) {
      return input as SandboxProviderID
    }
  }

  get(id: SandboxProviderID) {
    return this.items[id]
  }

  default(cfg?: SandboxConfig) {
    return this.provider(cfg?.default_provider) ?? "daytona"
  }

  authSync<T extends SandboxProviderID>(cfg: SandboxConfig | undefined, id: T) {
    return this.items[id].read(cfg)
  }

  hasAuth(cfg: SandboxConfig | undefined, id: SandboxProviderID) {
    return this.items[id].configured(cfg)
  }

  async authManaged<T extends SandboxProviderID>(id: T) {
    return this.items[id].managed()
  }

  async auth<T extends SandboxProviderID>(cfg: SandboxConfig | undefined, id: T) {
    return this.items[id].auth(cfg)
  }

  list(cfg?: SandboxConfig) {
    const def = this.default(cfg)
    return {
      default_provider: def,
      providers: sandbox_provider_ids.map((id) => {
        const item = this.items[id]
        return {
          id,
          label: item.label,
          fields: item.fields,
          configured: item.configured(cfg),
          source: item.read(cfg) ? "config" as const : item.configured(cfg) ? "managed" as const : "none" as const,
          default: id === def,
        }
      }),
    }
  }

  assert(id: SandboxProviderID, net?: SandboxNetworkPolicy) {
    this.items[id].assert(net)
  }

  async acquire(
    workspaceId: string,
    projectId: string,
    net?: SandboxNetworkPolicy,
    provider?: SandboxProviderID,
  ): Promise<SandboxHandle> {
    const picked = await this.pick(provider)
    picked.item.assert(net)
    const sandbox = await picked.item.acquire({
      cfg: picked.cfg,
      workspaceId,
      projectId,
      net,
    })
    log.info("Acquired sandbox", { provider: picked.item.id, sandboxId: sandbox.id, workspaceId })
    return sandbox
  }

  async attach(sandboxId: string, provider: SandboxProviderID) {
    const picked = await this.pick(provider)
    return picked.item.attach({
      cfg: picked.cfg,
      sandboxId,
    })
  }

  async acquireFromSnapshot(
    workspaceId: string,
    projectId: string,
    snapshotId: string,
    net?: SandboxNetworkPolicy,
    provider?: SandboxProviderID,
  ): Promise<SandboxHandle> {
    const picked = await this.pick(provider)
    picked.item.assert(net)
    const sandbox = await picked.item.acquireFromSnapshot({
      cfg: picked.cfg,
      workspaceId,
      projectId,
      snapshotId,
      net,
    })
    if (!sandbox) {
      throw new Error(`Sandbox provider ${picked.item.id} does not support snapshot restore`)
    }
    log.info("Acquired sandbox from snapshot", {
      provider: picked.item.id,
      sandboxId: sandbox.id,
      workspaceId,
      snapshotId,
    })
    return sandbox
  }

  async acquireFromImage(
    workspaceId: string,
    projectId: string,
    imageId: string,
    net?: SandboxNetworkPolicy,
    provider?: SandboxProviderID,
  ): Promise<SandboxHandle> {
    const picked = await this.pick(provider)
    picked.item.assert(net)
    const sandbox = await picked.item.acquireFromImage({
      cfg: picked.cfg,
      workspaceId,
      projectId,
      imageId,
      net,
    })
    if (!sandbox) {
      throw new Error(`Sandbox provider ${picked.item.id} does not support prepared images`)
    }
    log.info("Acquired sandbox from image", {
      provider: picked.item.id,
      sandboxId: sandbox.id,
      workspaceId,
      imageId,
    })
    return sandbox
  }

  async release(sandbox: SandboxHandle) {
    try {
      await sandbox.destroy()
      log.info("Released sandbox", { provider: sandbox.provider, sandboxId: sandbox.id })
    } catch (err) {
      log.warn("Failed to release sandbox", {
        provider: sandbox.provider,
        sandboxId: sandbox.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    this.items[sandbox.provider].released()
  }

  async poolEnabled() {
    const cfg = await loadUserConfig()
    const id = this.default(cfg.sandbox)
    if (id !== "daytona") return false
    return this.daytona.poolEnabled(cfg.sandbox)
  }

  async initPool() {
    const cfg = await loadUserConfig()
    if (this.default(cfg.sandbox) !== "daytona") return
    return this.daytona.initPool(cfg.sandbox)
  }

  startPoolMonitor() {
    this.daytona.startPoolMonitor()
  }

  shutdown() {
    this.daytona.shutdown()
  }

  private async pick(provider?: SandboxProviderID) {
    const cfg = await loadUserConfig()
    const id = provider ?? this.default(cfg.sandbox)
    return {
      cfg: cfg.sandbox,
      item: this.items[id],
    }
  }
}
