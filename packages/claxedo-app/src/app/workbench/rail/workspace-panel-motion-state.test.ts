import { describe, expect, test } from "bun:test"
import { createRoot, flush } from "solid-js"

import { createWorkspacePanelMotionState } from "./workspace-panel-motion-state"

describe("createWorkspacePanelMotionState", () => {
  test("opens immediately through the single reactive owner", async () => {
    await withMotion(async (motion) => {
      motion.setVisualPhase(true)

      expect(motion.visualOpen()).toBe(true)
      expect(motion.visualOpenValue()).toBe(true)
      expect(motion.bridgeChromeVisible()).toBe(true)

      await delay(160)
      expect(motion.bridgeChromeVisible()).toBe(false)
    })
  })

  test("keeps an optimistic open phase until committed state catches up", async () => {
    await withMotion(async (motion) => {
      motion.setVisualPhase(true)

      expect(motion.reconcileCommittedOpen(false)).toBe(false)
      expect(motion.visualOpen()).toBe(true)

      expect(motion.reconcileCommittedOpen(true)).toBe(true)
      expect(motion.visualOpen()).toBe(true)
      expect(motion.reconcileCommittedOpen(true)).toBe(true)
      expect(motion.bridgeChromeVisible()).toBe(true)

      await delay(160)
      expect(motion.bridgeChromeVisible()).toBe(false)
    })
  })

  test("clears stale bridge chrome when a later authoritative action opens the panel", async () => {
    await withMotion(async (motion) => {
      motion.setVisualPhase(false)
      expect(motion.reconcileCommittedOpen(false)).toBe(true)
      expect(motion.bridgeChromeVisible()).toBe(true)

      flush(() => expect(motion.reconcileCommittedOpen(true)).toBe(true))
      expect(motion.visualOpen()).toBe(true)
      expect(motion.bridgeChromeVisible()).toBe(false)
    })
  })

  test("rapid close cancels stale bridge cleanup before the next open", async () => {
    await withMotion(async (motion) => {
      motion.setVisualPhase(true)
      await delay(40)
      motion.setVisualPhase(false)
      await delay(140)

      expect(motion.bridgeChromeVisible()).toBe(true)
      expect(motion.visualOpen()).toBe(false)

      motion.setVisualPhase(true)
      await delay(160)
      expect(motion.bridgeChromeVisible()).toBe(false)
      expect(motion.visualOpen()).toBe(true)
    })
  })
})

async function withMotion(run: (motion: ReturnType<typeof createWorkspacePanelMotionState>) => void | Promise<void>) {
  const root = createRoot((dispose) => ({
    dispose,
    motion: createWorkspacePanelMotionState({
      initialOpen: false,
    }),
  }))

  try {
    await run(root.motion)
  } finally {
    root.dispose()
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
