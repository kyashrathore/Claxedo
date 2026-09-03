import { describe, expect, test } from "vitest"

import {
  DeploymentProfileError,
  STATIC_PRODUCT_DESCRIPTORS,
  resolveDeploymentProfile,
  resolveDeploymentProfileFromEnv,
  type DeploymentProfileInput,
} from "./deployment-profile"

const userDeployed = {
  adapterProfile: "better-auth-d1",
  productPosture: "user-deployed",
  sandboxPosture: "control-plane-only",
} satisfies DeploymentProfileInput

describe("hosted deployment profile", () => {
  test("defines product posture independently from adapters and sandbox resources", () => {
    expect(STATIC_PRODUCT_DESCRIPTORS["user-deployed"]).toEqual({
      productPosture: "user-deployed",
      organizationPolicy: "single-org",
      billing: "absent",
      multiplayer: true,
    })
    expect(STATIC_PRODUCT_DESCRIPTORS["claxedo-hosted"]).toMatchObject({
      organizationPolicy: "multi-org",
      billing: "polar",
      multiplayer: true,
    })
  })
  test("resolves the user-deployed product as one-org multiplayer with a hard billing closure", () => {
    expect(resolveDeploymentProfile(userDeployed)).toEqual({
      adapterProfile: "better-auth-d1",
      authAdapter: "better-auth",
      controlPlaneAdapter: "d1",
      productPosture: "user-deployed",
      organizationPolicy: "single-org",
      multiplayer: true,
      billing: "absent",
      sandboxPosture: "control-plane-only",
    })
  })

  test("resolves the certified Claxedo-hosted adapter profile with Polar billing", () => {
    expect(
      resolveDeploymentProfile({
        adapterProfile: "better-auth-d1",
        productPosture: "claxedo-hosted",
        sandboxPosture: "full-hosted",
        sandboxDriver: "cloudflare",
      }),
    ).toMatchObject({
      adapterProfile: "better-auth-d1",
      productPosture: "claxedo-hosted",
      organizationPolicy: "multi-org",
      multiplayer: true,
      billing: "polar",
      sandboxPosture: "full-hosted",
      sandboxDriver: "cloudflare",
    })
  })

  test("rejects uncertified product and adapter combinations", () => {
    expect(() =>
      resolveDeploymentProfile({
        adapterProfile: "better-auth-d1",
        productPosture: "user-deployed",
        sandboxPosture: "full-hosted",
      }),
    ).toThrowError(DeploymentProfileError)
  })

  test.each([
    ["adapter profile", { ...userDeployed, adapterProfile: undefined }],
    ["product posture", { ...userDeployed, productPosture: undefined }],
    ["sandbox posture", { ...userDeployed, sandboxPosture: undefined }],
  ])("requires an explicit %s", (_name, input) => {
    expect(() => resolveDeploymentProfile(input)).toThrowError(DeploymentProfileError)
  })

  test("does not accept an unknown auth and storage pair as a production profile", () => {
    for (const adapterProfile of ["better-auth-kv", "session-cookie-d1", "oidc-d1"]) {
      expect(() =>
        resolveDeploymentProfile({
          adapterProfile,
          productPosture: "claxedo-hosted",
          sandboxPosture: "control-plane-only",
        }),
      ).toThrowError(/adapter profile must be "better-auth-d1"/)
    }
  })

  test("requires exactly one explicit sandbox driver for full-hosted", () => {
    expect(() =>
      resolveDeploymentProfile({
        adapterProfile: "better-auth-d1",
        productPosture: "claxedo-hosted",
        sandboxPosture: "full-hosted",
      }),
    ).toThrowError(/full-hosted requires an explicit sandbox driver/)

    expect(() =>
      resolveDeploymentProfile({
        ...userDeployed,
        sandboxDriver: "daytona",
      }),
    ).toThrowError(/control-plane-only forbids a sandbox driver/)
  })

  test("rejects unknown values instead of selecting a default", () => {
    expect(() =>
      resolveDeploymentProfile({
        adapterProfile: "auto",
        productPosture: "self-hosted",
        sandboxPosture: "hosted",
        sandboxDriver: "from-credentials",
      }),
    ).toThrowError(DeploymentProfileError)
  })

  test("reads only explicit deployment axes and never infers them from credentials", () => {
    expect(() =>
      resolveDeploymentProfileFromEnv({
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://authority.test",
        CLOUDFLARE_API_TOKEN: "cloudflare-secret",
      }),
    ).toThrowError(/adapter profile must be "better-auth-d1"/)

    expect(
      resolveDeploymentProfileFromEnv({
        CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
        CLAXEDO_PRODUCT_POSTURE: "user-deployed",
        CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "ignored-for-selection",
      }),
    ).toEqual(resolveDeploymentProfile(userDeployed))
  })
})
