import { describe, expect, test } from "vitest"
import * as zod from "zod"
import * as zodV4 from "zod/v4"

import {
  CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS,
  certifiedHostedWorkerArtifact,
} from "../../src/deployments/hosted-workerd/certified-worker-artifacts"
import { HOSTED_WORKER_BUNDLE_CONTRACT } from "./hosted-worker-bundle"
import { renderHostedCoreWranglerConfig } from "./render-hosted-core-config"
import { renderBetterAuthD1WranglerConfig } from "./release-better-auth-d1"

const ZOD_ALIAS = '[alias]\n"zod/v4" = "zod"'

function coreConfig(artifactId: (typeof CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS)[number]) {
  const artifact = certifiedHostedWorkerArtifact(artifactId, "staging")
  return renderHostedCoreWranglerConfig({
    artifactId,
    deploymentId: "deployment-staging",
    authDatabase: { name: "claxedo-auth-staging", id: "11111111-1111-4111-8111-111111111111" },
    controlPlaneDatabase: { name: "claxedo-core-staging", id: "22222222-2222-4222-8222-222222222222" },
    limiter: { owner: "core", environment: "staging", namespaceId: "3101" },
    ...(artifact.resources.liveSyncRoom
      ? { userDeployedOrganization: { id: "org_staging", name: "Staging" } }
      : {}),
  })
}

describe("the certified hosted Worker bundle contract", () => {
  test("every certified artifact's config aliases zod/v4, in both renderers", () => {
    expect(HOSTED_WORKER_BUNDLE_CONTRACT).toContain(ZOD_ALIAS)
    for (const artifactId of CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS) {
      expect(coreConfig(artifactId), artifactId).toContain(ZOD_ALIAS)
    }
    expect(
      renderBetterAuthD1WranglerConfig({
        staging: true,
        authDatabaseId: "11111111-1111-4111-8111-111111111111",
        authDatabaseName: "claxedo-auth-staging",
        controlPlaneDatabaseId: "22222222-2222-4222-8222-222222222222",
        controlPlaneDatabaseName: "claxedo-core-staging",
        namespaceId: "3101",
      }),
    ).toContain(ZOD_ALIAS)
  })

  test("the alias table closes the top-level keys it follows", () => {
    for (const artifactId of CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS) {
      const config = coreConfig(artifactId)
      const afterAlias = config.slice(config.indexOf(ZOD_ALIAS) + ZOD_ALIAS.length).split("\n")
      const insideAliasTable = afterAlias.slice(0, afterAlias.findIndex((line) => line.startsWith("[")))
      expect(insideAliasTable.filter((line) => /^[A-Za-z_]/.test(line)), artifactId).toEqual([])
    }
  })

  test("aliasing zod/v4 to zod substitutes the same named exports", () => {
    const aliased = Object.keys(zodV4).filter((name) => name !== "default")
    expect(aliased.length).toBeGreaterThan(100)
    const substituted = zod as unknown as Record<string, unknown>
    const original = zodV4 as unknown as Record<string, unknown>
    expect(aliased.filter((name) => substituted[name] !== original[name])).toEqual([])
  })
})
