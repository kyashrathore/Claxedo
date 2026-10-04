import { describe, expect, test } from "vitest"
import { resolveEffectiveActivation } from "./effective"

const identity = {
  pluginInstanceId: "org-tools:review",
  harnessId: "opencode" as const,
}

describe("resolveEffectiveActivation", () => {
  test("resolves signed precedence from project through Claxedo", () => {
    const common = {
      ...identity,
      mode: "signed" as const,
      pins: {
        user: "sha256:user",
        organization: "sha256:org",
        claxedo: "sha256:claxedo",
      } as const,
      organizationDefault: true,
      claxedoDefault: true,
    }

    expect(resolveEffectiveActivation({ ...common, projectOverride: false, userDefault: true })).toEqual({
      status: "ready",
      effective: false,
      winner: "project",
    })
    expect(resolveEffectiveActivation({ ...common, userDefault: true })).toEqual({
      status: "ready",
      effective: true,
      winner: "user-default",
      artifactDigest: "sha256:user",
    })
    expect(resolveEffectiveActivation(common)).toEqual({
      status: "ready",
      effective: true,
      winner: "organization",
      artifactDigest: "sha256:org",
    })
    expect(resolveEffectiveActivation({
      ...common,
      organizationDefault: false,
    })).toEqual({
      status: "ready",
      effective: true,
      winner: "claxedo",
      artifactDigest: "sha256:claxedo",
    })
  })

  test("an explicit project true uses the user authority pin", () => {
    expect(resolveEffectiveActivation({
      ...identity,
      mode: "signed",
      projectOverride: true,
      organizationDefault: true,
      claxedoDefault: true,
      pins: {
        user: "sha256:user",
        organization: "sha256:org",
        claxedo: "sha256:claxedo",
      },
    })).toEqual({
      status: "ready",
      effective: true,
      winner: "project",
      artifactDigest: "sha256:user",
    })
  })

  test("keeps desired activation visible when the winning artifact is unavailable", () => {
    expect(resolveEffectiveActivation({
      ...identity,
      mode: "signed",
      userDefault: true,
      organizationDefault: true,
      pins: { organization: "sha256:org" },
    })).toEqual({
      status: "artifact-unavailable",
      effective: true,
      winner: "user-default",
    })
  })

  test("uses one machine-wide override in unsigned mode", () => {
    expect(resolveEffectiveActivation({
      ...identity,
      mode: "unsigned",
      machineOverride: true,
      claxedoDefault: false,
      pins: { localMachine: "sha256:machine", claxedo: "sha256:claxedo" },
    })).toEqual({
      status: "ready",
      effective: true,
      winner: "machine",
      artifactDigest: "sha256:machine",
    })
    expect(resolveEffectiveActivation({
      ...identity,
      mode: "unsigned",
      machineOverride: false,
      claxedoDefault: true,
      pins: { localMachine: "sha256:machine", claxedo: "sha256:claxedo" },
    })).toEqual({
      status: "ready",
      effective: false,
      winner: "machine",
    })
  })

  test("returns one explicit disabled result when no authority enables the plugin", () => {
    expect(resolveEffectiveActivation({
      ...identity,
      mode: "signed",
      pins: {},
    })).toEqual({
      status: "ready",
      effective: false,
      winner: "none",
    })
  })
})
