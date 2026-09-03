import { describe, expect, test } from "vitest"

import { renderWorkGraphServiceWranglerFromEnvironment } from "./render-config"

const env = {
  CLAXEDO_WORKGRAPH_ENVIRONMENT: "staging",
  CLAXEDO_WORKGRAPH_ENVIRONMENT_ID: "environment-staging",
  CLAXEDO_WORKGRAPH_DEPLOYMENT_ID: "deployment-staging",
  CLAXEDO_WORKGRAPH_WORKER_NAME: "claxedo-workgraph-staging",
  CLAXEDO_WORKGRAPH_DATABASE_NAME: "claxedo-workgraph-staging",
  CLAXEDO_WORKGRAPH_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
  CLAXEDO_WORKGRAPH_SERVICE_BUILD_ID: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
}

describe("WorkGraph deploy configuration", () => {
  test("renders an independently deployable, initially disabled Worker", () => {
    const config = renderWorkGraphServiceWranglerFromEnvironment(env)
    expect(config).toContain('name = "claxedo-workgraph-staging"')
    expect(config).toContain('main = "src/worker.cf.ts"')
    expect(config).toContain('CLAXEDO_WORKGRAPH_INITIAL_STATE = "installed_disabled"')
    expect(config).toContain('binding = "WORKGRAPH_DB"')
    expect(config).toContain('name = "WORKGRAPH_SETTLER"')
    expect(config).toContain('name = "WORKGRAPH_WAKE_LANE"')
    expect(config).not.toMatch(/AUTH_DB|CONTROL_PLANE_DB|DOCUMENTS|CLERK|CONVEX|BETTER_AUTH|\[\[services\]\]/)
  })

  test("refuses an incomplete or non-production environment instead of inventing deployment identity", () => {
    expect(() =>
      renderWorkGraphServiceWranglerFromEnvironment({ ...env, CLAXEDO_WORKGRAPH_DEPLOYMENT_ID: "" }),
    ).toThrow(/CLAXEDO_WORKGRAPH_DEPLOYMENT_ID/)
    expect(() =>
      renderWorkGraphServiceWranglerFromEnvironment({ ...env, CLAXEDO_WORKGRAPH_ENVIRONMENT: "dev" }),
    ).toThrow(/staging or production/)
  })
})
