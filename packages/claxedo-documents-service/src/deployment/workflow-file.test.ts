import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const workflow = readFileSync(
  new URL("../../../../.github/workflows/deploy-documents-service.yml", import.meta.url),
  "utf8",
)

describe("Documents independent release workflow", () => {
  test("verifies and deploys only the Documents service through an explicit dark release", () => {
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("packages/claxedo-documents-service")
    expect(workflow).toContain("d1 migrations apply DOCUMENTS_DB --remote")
    expect(workflow).toContain('r2 bucket info "$CLAXEDO_DOCUMENTS_BUCKET_NAME"')
    expect(workflow).toContain("refusing dark deploy while Documents lifecycle is")
    expect(workflow).toContain("Deploy Documents Worker dark")
    expect(workflow).not.toMatch(/deploy-control-plane|claxedo-server\/wrangler|claxedo-workgraph-service/)
  })
})
