import { validateSandboxPersistenceCapabilities, type SandboxDriverMetadata } from "./index"
import { workspaceRuntimeVersion } from "./runtime-version"
import { defaultSandboxImage } from "./image-name"
import {
  defaultSandboxDriverID,
  dockerSandboxDriverEnabled as contractDockerSandboxDriverEnabled,
  listSandboxDrivers,
  sandboxDriverAuthValues,
  sandboxDriverCredentialFields,
  sandboxDriverId,
  sandboxDriverLabels,
  type SandboxDriverAuth,
  type SandboxDriverConfig,
  type SandboxDriverEnv,
  type SandboxDriverID,
} from "@claxedo/sandbox-contract"

export { defaultSandboxDriverID, listSandboxDrivers, sandboxDriverId }

export type SandboxDriverCatalogEntry = {
  id: SandboxDriverID
  label: string
  metadata: SandboxDriverMetadata
  credentialFields: ReadonlyArray<{ key: string; label: string; secret?: boolean }>
}

export { validateSandboxPersistenceCapabilities }

export const sandboxDriverCatalog: Record<SandboxDriverID, SandboxDriverCatalogEntry> = {
  exe: {
    id: "exe",
    label: sandboxDriverLabels.exe,
    credentialFields: sandboxDriverCredentialFields.exe,
    metadata: {
      driverRunsIn: ["worker", "node"],
      hostStopBehavior: "not-supported",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
      egressControl: "none",
      persistence: {
        resume: "same-sandbox",
        capture: "none",
        clone: true,
        captureSource: "not-applicable",
        retention: "provider-managed",
        restoreMount: "same-resource",
      },
    },
  },
  daytona: {
    id: "daytona",
    label: sandboxDriverLabels.daytona,
    credentialFields: sandboxDriverCredentialFields.daytona,
    metadata: {
      driverRunsIn: ["worker", "node"],
      hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "native",
      // The driver translates names to domainAllowList, or addresses to networkAllowList.
      egressControl: "hosts-and-cidrs",
      persistence: {
        resume: "same-sandbox",
        capture: "filesystem",
        clone: false,
        captureSource: "preserved",
        retention: "provider-managed",
        restoreMount: "new-resource",
      },
    },
  },
  modal: {
    id: "modal",
    label: sandboxDriverLabels.modal,
    credentialFields: sandboxDriverCredentialFields.modal,
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
      targetAccess: "relay",
      secretBrokering: "none",
      // The driver does not install Modal's domain allowlist or alpha sidecar.
      egressControl: "none",
      persistence: {
        resume: "replacement-restore",
        capture: "filesystem",
        clone: false,
        captureSource: "preserved",
        retention: "provider-managed",
        restoreMount: "new-resource",
      },
    },
  },
  vercel: {
    id: "vercel",
    label: sandboxDriverLabels.vercel,
    credentialFields: sandboxDriverCredentialFields.vercel,
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
      targetAccess: "relay",
      secretBrokering: "native",
      // The driver translates hosts only; the SDK's subnet rules are not wired to net.cidrs.
      egressControl: "hosts",
      persistence: {
        resume: "replacement-restore",
        capture: "filesystem",
        clone: false,
        captureSource: "stopped",
        retention: "explicit",
        restoreMount: "new-resource",
      },
    },
  },
  cloudflare: {
    id: "cloudflare",
    label: sandboxDriverLabels.cloudflare,
    credentialFields: sandboxDriverCredentialFields.cloudflare,
    metadata: {
      driverRunsIn: ["worker"],
      hostStopBehavior: "not-supported", hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "native",
      // Credential handlers do not restrict unrelated destinations.
      egressControl: "none",
      persistence: {
        resume: "replacement-restore",
        capture: "directories",
        clone: false,
        captureSource: "preserved",
        retention: "provider-managed",
        restoreMount: "copy-on-write",
      },
    },
  },
  box: {
    id: "box",
    label: sandboxDriverLabels.box,
    credentialFields: sandboxDriverCredentialFields.box,
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
      egressControl: "none",
      persistence: {
        resume: "same-sandbox",
        capture: "none",
        clone: false,
        captureSource: "not-applicable",
        retention: "provider-managed",
        restoreMount: "same-resource",
      },
    },
  },
  docker: {
    id: "docker",
    label: sandboxDriverLabels.docker,
    credentialFields: sandboxDriverCredentialFields.docker,
    metadata: {
      driverRunsIn: ["local"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "same-host",
      targetAccess: "loopback",
      secretBrokering: "none",
      egressControl: "none",
      persistence: {
        resume: "replacement-restore",
        capture: "same-resource",
        clone: false,
        captureSource: "preserved",
        retention: "provider-managed",
        restoreMount: "same-resource",
      },
    },
  },
}

export function sandboxDriverAuth<T extends SandboxDriverID>(
  cfg: SandboxDriverConfig | undefined,
  id: T,
  env: SandboxDriverEnv = process.env,
): SandboxDriverAuth[T] | undefined {
  if (id === "docker") {
    const configured = sandboxDriverAuthValues(cfg, "docker", env)
    if (!configured) return undefined
    const image = configured.image ?? defaultSandboxImage(workspaceRuntimeVersion(), undefined, env)
    return { image } as SandboxDriverAuth[T]
  }
  return sandboxDriverAuthValues(cfg, id, env)
}

export function hasSandboxDriverAuth(
  cfg: SandboxDriverConfig | undefined,
  id: SandboxDriverID,
  env: SandboxDriverEnv = process.env,
) {
  return !!sandboxDriverAuth(cfg, id, env)
}

export function dockerSandboxDriverEnabled(env: SandboxDriverEnv = process.env) {
  return contractDockerSandboxDriverEnabled(env)
}
