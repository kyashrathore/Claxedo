import { describe, expect, test } from "vitest"
import { boatBilling, cloudflareBilling, sandboxMachineCostUsd, sandboxMachineRate } from "./driver-billing"
import { sandboxDriverCatalog } from "./driver-catalog"

const HOUR_MS = 3_600_000

describe("sandbox driver billing", () => {
  test("Boat prices each size per hour as its pricing page publishes, and an hour on each costs that", () => {
    expect(Object.entries(boatBilling.rates).map(([machineClass, rate]) => [machineClass, rate.vcpu, rate.memoryGb, rate.usdPerHour])).toEqual([
      ["small", 2, 4, 0.018],
      ["default", 4, 8, 0.036],
      ["large", 8, 16, 0.072],
    ])
    expect(sandboxMachineRate(boatBilling, "small")?.size).toBe("small")
    expect(sandboxMachineRate(boatBilling, null)?.size).toBe("default")
    expect(sandboxMachineCostUsd(sandboxMachineRate(boatBilling, "large")!, HOUR_MS)).toBeCloseTo(0.072, 10)
    expect(sandboxMachineCostUsd(sandboxMachineRate(boatBilling, "small")!, 30 * 60_000)).toBeCloseTo(0.009, 10)
    expect(boatBilling.source).toEqual({ url: "https://docs.boat.dev/pricing", readOn: "2026-10-12" })
  })

  test("Cloudflare's one size is standard-1, priced for its memory and disk per second and naming the CPU the rate leaves out", () => {
    const rate = sandboxMachineRate(cloudflareBilling, null)
    expect(rate).toMatchObject({ size: "standard-1", vcpu: 0.5, memoryGb: 4 })
    expect(rate?.usdPerHour).toBeCloseTo((4 * 0.0000025 + 8 * 0.00000007) * 3_600, 12)
    expect(sandboxMachineRate(cloudflareBilling, "large")).toBe(rate)
    expect(cloudflareBilling.excludes).toMatch(/active CPU/)
    expect(cloudflareBilling.source.url).toBe("https://developers.cloudflare.com/containers/pricing/")
  })

  test("the catalog carries the billing of the drivers with a published rate and none for the others", () => {
    expect(sandboxDriverCatalog.boat.billing).toBe(boatBilling)
    expect(sandboxDriverCatalog.cloudflare.billing).toBe(cloudflareBilling)
    expect(sandboxDriverCatalog.modal.billing).toBeUndefined()
    expect(sandboxDriverCatalog.vercel.billing).toBeUndefined()
    expect(sandboxDriverCatalog.docker.billing).toBeUndefined()
    expect(sandboxMachineRate(undefined, "small")).toBeUndefined()
  })
})
