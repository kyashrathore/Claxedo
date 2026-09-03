import { describe, expect, test } from "vitest"

import { renderDocumentsServiceWranglerFromEnvironment } from "./render-config"

const env = {
  CLAXEDO_DOCUMENTS_ENVIRONMENT: "staging",
  CLAXEDO_DOCUMENTS_ENVIRONMENT_ID: "environment-staging",
  CLAXEDO_DOCUMENTS_DEPLOYMENT_ID: "deployment-staging",
  CLAXEDO_DOCUMENTS_WORKER_NAME: "claxedo-documents-staging",
  CLAXEDO_DOCUMENTS_DATABASE_NAME: "claxedo-documents-staging",
  CLAXEDO_DOCUMENTS_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
  CLAXEDO_DOCUMENTS_BUCKET_NAME: "claxedo-documents-staging",
  CLAXEDO_DOCUMENTS_SERVICE_BUILD_ID: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
}

describe("Documents deploy configuration", () => {
  test("renders an independently deployable, initially disabled Worker", () => {
    const config = renderDocumentsServiceWranglerFromEnvironment(env)
    expect(config).toContain('name = "claxedo-documents-staging"')
    expect(config).toContain('main = "src/worker.cf.ts"')
    expect(config).toContain('CLAXEDO_DOCUMENTS_INITIAL_STATE = "installed_disabled"')
    expect(config).toContain('binding = "DOCUMENTS_DB"')
    expect(config).toContain('binding = "DOCUMENTS_BUCKET"')
    expect(config).not.toMatch(/AUTH_DB|CONTROL_PLANE_DB|BETTER_AUTH|\[\[services\]\]/)
  })

  test("refuses an incomplete or non-production environment instead of inventing deployment identity", () => {
    expect(() => renderDocumentsServiceWranglerFromEnvironment({ ...env, CLAXEDO_DOCUMENTS_DATABASE_ID: "" })).toThrow(
      /CLAXEDO_DOCUMENTS_DATABASE_ID/,
    )
    expect(() =>
      renderDocumentsServiceWranglerFromEnvironment({ ...env, CLAXEDO_DOCUMENTS_ENVIRONMENT: "dev" }),
    ).toThrow(/staging or production/)
  })
})
