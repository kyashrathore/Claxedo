import path from "node:path"

import { describe, expect, test } from "vitest"
import * as zodV4 from "zod/v4"

import {
  CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS,
  certifiedHostedWorkerArtifact,
} from "../../src/deployments/hosted-workerd/certified-worker-artifacts"
import { HOSTED_WORKER_BUNDLE_CONTRACT } from "./hosted-worker-bundle"
import { STAGED_CONTROL_PLANE_MIGRATIONS_DIR } from "./staged-control-plane-migrations"
import { renderWorkerWranglerConfig } from "./wrangler-config"

const ALIAS_TABLE = /\[alias\]\n"zod\/v4" = ("[^"\n]+")/

function zodAliasTarget(rendered: string): string {
  const target = ALIAS_TABLE.exec(rendered)?.[1]
  if (!target) throw new Error("the config declares no zod/v4 alias")
  return JSON.parse(target)
}

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
    documentsBucket: "claxedo-documents",
    ...(artifact.agentPlugins ? { agentPluginsBucket: "claxedo-agent-plugins" } : {}),
    variables: { CLAXEDO_DEPLOYMENT_ID: "claxedo" },
  })
}

describe("the certified hosted Worker bundle contract", () => {
  test("every certified artifact's config aliases zod/v4 to zod's ES module entry", () => {
    const target = zodAliasTarget(HOSTED_WORKER_BUNDLE_CONTRACT)
    expect(path.isAbsolute(target)).toBe(true)
    expect(target.endsWith(path.join("zod", "index.js"))).toBe(true)
    for (const artifactId of CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS) {
      expect(zodAliasTarget(config(artifactId)), artifactId).toBe(target)
    }
  })

  test("the alias table closes the top-level keys it follows", () => {
    for (const artifactId of CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS) {
      const rendered = config(artifactId)
      const alias = ALIAS_TABLE.exec(rendered)
      if (!alias) throw new Error(`${artifactId} declares no zod/v4 alias`)
      const afterAlias = rendered.slice(alias.index + alias[0].length).split("\n")
      const insideAliasTable = afterAlias.slice(0, afterAlias.findIndex((line) => line.startsWith("[")))
      expect(insideAliasTable.filter((line) => /^[A-Za-z_]/.test(line)), artifactId).toEqual([])
    }
  })

  test("the aliased entry substitutes the same named exports as zod/v4", async () => {
    const zod: unknown = await import(zodAliasTarget(HOSTED_WORKER_BUNDLE_CONTRACT))
    const aliased = Object.keys(zodV4).filter((name) => name !== "default")
    expect(aliased.length).toBeGreaterThan(100)
    const substituted = zod as unknown as Record<string, unknown>
    const original = zodV4 as unknown as Record<string, unknown>
    expect(aliased.filter((name) => substituted[name] !== original[name])).toEqual([])
  })
})
