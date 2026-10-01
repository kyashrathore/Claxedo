import { ensurePinnedPi, PINNED_PI } from "../../../harness/e2e/harness/pinned-pi.ts"

if (!process.env.PI_EXECUTABLE) {
  await ensurePinnedPi()
  process.env.PI_EXECUTABLE = PINNED_PI
}
