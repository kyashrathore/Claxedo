import path from "node:path"

import { describe, expect, test } from "vitest"
import * as zod from "zod"
import * as zodV4 from "zod/v4"

import {
  CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS,
  certifiedHostedWorkerArtifact,
} from "../../src/deployments/hosted-workerd/certified-worker-artifacts"
import { HOSTED_WORKER_BUNDLE_CONTRACT } from "./hosted-worker-bundle"
import { STAGED_CONTROL_PLANE_MIGRATIONS_DIR } from "./staged-control-plane-migrations"
import { renderWorkerWranglerConfig } from "./wrangler-config"

const ZOD_ALIAS = '[alias]\n"zod/v4" = "zod"'

function config(artifactId: (typeof CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS)[number]) {
  const artifact = certifiedHostedWorkerArtifact(artifactId)
  return renderWorkerWranglerConfig({
    workerName: "claxedo",
    artifact,
    configDirectory: path.resolve(import.meta.dirname, "../../.claxedo-deploy"),
    authDatabase: { name: "claxedo-auth", id: "11111111-1111-4111-8111-111111111111" },
    controlPlaneDatabase: { name: "claxedo-control-plane", id: "22222222-2222-4222-8222-222222222222" },
    controlPlaneMigrationsDir: STAGED_CONTROL_PLANE_MIGRATIONS_DIR,
    requestLimiterNamespaceId: "3101",
    ...(artifact.agentPlugins ? { agentPluginsBucket: "claxedo-agent-plugins" } : {}),
    variables: { CLAXEDO_DEPLOYMENT_ID: "claxedo" },
  })
}

describe("the certified hosted Worker bundle contract", () => {
  test("every certified artifact's config aliases zod/v4", () => {
    expect(HOSTED_WORKER_BUNDLE_CONTRACT).toContain(ZOD_ALIAS)
    for (const artifactId of CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS) {
      expect(config(artifactId), artifactId).toContain(ZOD_ALIAS)
    }
  })

  test("the alias table closes the top-level keys it follows", () => {
    for (const artifactId of CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS) {
      const rendered = config(artifactId)
      const afterAlias = rendered.slice(rendered.indexOf(ZOD_ALIAS) + ZOD_ALIAS.length).split("\n")
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
