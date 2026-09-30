import { PI_VERSION } from "./config"
import { ensurePinned, pinnedBin, type PinnedPackage } from "./pinned-package"

const PI: PinnedPackage = { label: "pi", npmPackage: "@earendil-works/pi-coding-agent", bin: "pi", version: PI_VERSION }

export const PINNED_PI = pinnedBin(PI)

export function ensurePinnedPi(): Promise<{ installed: boolean; version: string }> {
  return ensurePinned(PI)
}
