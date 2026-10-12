import type { SandboxMachineClass } from "@claxedo/sandbox-contract"

/** One size a provider sells, as its own catalog names and prices it. */
export type SandboxMachineRate = {
  /** The provider's own name for the size. */
  size: string
  vcpu: number
  memoryGb: number
  usdPerHour: number
}

/**
 * How a provider bills the machine a sandbox runs on, read from its published
 * pricing. `rates.default` is also the one size of a driver that offers no
 * choice. `excludes` names a component the hourly rate leaves out because the
 * provider meters it on use rather than on time.
 */
export type SandboxDriverBilling = {
  source: { url: string; readOn: string }
  meter: string
  rates: Partial<Record<SandboxMachineClass, SandboxMachineRate>>
  excludes?: string
}

const HOUR_SECONDS = 3_600

export const boatBilling: SandboxDriverBilling = {
  source: { url: "https://docs.boat.dev/pricing", readOn: "2026-10-12" },
  meter: "Boat bills machine time per second while a sandbox runs, at an hourly rate per size; a stopped sandbox costs nothing.",
  rates: {
    small: { size: "small", vcpu: 2, memoryGb: 4, usdPerHour: 0.018 },
    default: { size: "default", vcpu: 4, memoryGb: 8, usdPerHour: 0.036 },
    large: { size: "large", vcpu: 8, memoryGb: 16, usdPerHour: 0.072 },
  },
}

const CLOUDFLARE_USD_PER_GIB_SECOND_MEMORY = 0.0000025
const CLOUDFLARE_USD_PER_GB_SECOND_DISK = 0.00000007
const CLOUDFLARE_USD_PER_VCPU_SECOND_ACTIVE = 0.00002
/** The instance type `scripts/sandbox/cloudflare-worker/wrangler.toml` runs the sandbox container on. */
const CLOUDFLARE_STANDARD_1 = { size: "standard-1", vcpu: 0.5, memoryGb: 4, diskGb: 8 }

export const cloudflareBilling: SandboxDriverBilling = {
  source: { url: "https://developers.cloudflare.com/containers/pricing/", readOn: "2026-10-12" },
  meter: "Cloudflare bills a container for every 10 ms it runs: memory at $0.0000025 per GiB-second and disk at $0.00000007 per GB-second for the whole run, plus CPU at $0.00002 per vCPU-second of active use.",
  rates: {
    default: {
      size: CLOUDFLARE_STANDARD_1.size,
      vcpu: CLOUDFLARE_STANDARD_1.vcpu,
      memoryGb: CLOUDFLARE_STANDARD_1.memoryGb,
      usdPerHour: (CLOUDFLARE_STANDARD_1.memoryGb * CLOUDFLARE_USD_PER_GIB_SECOND_MEMORY + CLOUDFLARE_STANDARD_1.diskGb * CLOUDFLARE_USD_PER_GB_SECOND_DISK) * HOUR_SECONDS,
    },
  },
  excludes: `active CPU, billed at $${CLOUDFLARE_USD_PER_VCPU_SECOND_ACTIVE} per vCPU-second and not measured by Claxedo, and the monthly allowance a Workers Paid plan includes`,
}

/** The rate a sandbox of this class runs at; a driver with one size answers it for the class it was not asked for. */
export function sandboxMachineRate(billing: SandboxDriverBilling | undefined, machineClass: SandboxMachineClass | null): SandboxMachineRate | undefined {
  if (!billing) return undefined
  return billing.rates[machineClass ?? "default"] ?? (Object.keys(billing.rates).length === 1 ? billing.rates.default : undefined)
}

export function sandboxMachineCostUsd(rate: SandboxMachineRate, activeMs: number): number {
  return (rate.usdPerHour * activeMs) / (HOUR_SECONDS * 1_000)
}
