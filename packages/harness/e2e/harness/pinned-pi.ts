import { PI_RANGE } from "../../src/transports/pi-rpc/version"
import { ensurePinned, pinnedBin, rangeEnd, type PinnedPackage } from "./pinned-package"

const PI: PinnedPackage = { label: "pi", npmPackage: "@earendil-works/pi-coding-agent", bin: "pi", version: rangeEnd(PI_RANGE, "CLAXEDO_E2E_PI") }

export const PINNED_PI = pinnedBin(PI)

export function ensurePinnedPi(): Promise<{ installed: boolean; version: string }> {
  return ensurePinned(PI)
}
