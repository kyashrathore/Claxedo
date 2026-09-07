import { describe, expect, test } from "bun:test"
import { DEFAULT_SOUND_ID } from "@/platform/notifications/sound"
import { migrateSettings } from "./provider"

describe("settings sound migration", () => {
  test("replaces persisted upstream sound ids that are not in the shipped catalog", () => {
    const migrated = migrateSettings({
      sounds: {
        agentEnabled: true,
        agent: "staplebops-01",
        permissionsEnabled: true,
        permissions: "staplebops-02",
        errorsEnabled: true,
        errors: "nope-03",
      },
    }) as { sounds: { agent: string; permissions: string; errors: string } }

    expect(migrated.sounds).toMatchObject({
      agent: DEFAULT_SOUND_ID,
      permissions: DEFAULT_SOUND_ID,
      errors: DEFAULT_SOUND_ID,
    })
  })

  test("preserves sound ids that resolve in the current catalog", () => {
    const value = {
      sounds: {
        agent: DEFAULT_SOUND_ID,
        permissions: DEFAULT_SOUND_ID,
        errors: DEFAULT_SOUND_ID,
      },
    }

    expect(migrateSettings(value)).toEqual(value)
  })
})
