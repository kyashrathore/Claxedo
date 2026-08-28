import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const workflow = readFileSync(
  new URL("../../../../.github/workflows/deploy-workgraph-service.yml", import.meta.url),
  "utf8",
)

describe("WorkGraph independent release workflow", () => {
  test("verifies and deploys only the WorkGraph service through an explicit dark release", () => {
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("packages/claxedo-workgraph-service")
    expect(workflow).toContain("d1 migrations apply WORKGRAPH_DB --remote")
    expect(workflow).toContain("refusing dark deploy while WorkGraph lifecycle is")
    expect(workflow).toContain("Deploy WorkGraph Worker dark")
    expect(workflow).not.toMatch(/deploy-control-plane|claxedo-server\/wrangler|claxedo-documents-service/)
  })
})
