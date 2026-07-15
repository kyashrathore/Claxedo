import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

const root = path.resolve(import.meta.dirname, "../../../..")
const controlPlane = fs.readFileSync(path.join(root, ".github/workflows/deploy-control-plane.yml"), "utf8")
const convex = fs.readFileSync(path.join(root, ".github/workflows/deploy-convex.yml"), "utf8")
const app = fs.readFileSync(path.join(root, ".github/workflows/deploy-claxedo-app.yml"), "utf8")
const appStaging = fs.readFileSync(path.join(root, ".github/workflows/deploy-claxedo-app-staging.yml"), "utf8")
const setupBun = fs.readFileSync(path.join(root, ".github/actions/setup-bun/action.yml"), "utf8")
const deployedBrowser = fs.readFileSync(
  path.join(root, "packages/claxedo-app/e2e/playwright/deployed-workgraph.spec.ts"),
  "utf8",
)
const deployedBrowserConfig = fs.readFileSync(
  path.join(root, "packages/claxedo-app/playwright.deployed.config.ts"),
  "utf8",
)
const appPlaywrightConfig = fs.readFileSync(path.join(root, "packages/claxedo-app/playwright.config.ts"), "utf8")

describe("Claxedo Cloud deployment workflow", () => {
  test("serializes every top-level deploy while the reusable app inherits its caller's lock", () => {
    expect(controlPlane).toContain("group: claxedo-cloud-deploy")
    expect(convex).toContain("group: claxedo-cloud-deploy")
    expect(appStaging).toContain("group: claxedo-cloud-deploy")
    expect(app).not.toContain("concurrency:")
    expect(app).not.toContain("push:")
    expect([controlPlane, convex, appStaging].every((source) => source.includes("cancel-in-progress: false"))).toBe(
      true,
    )
  })

  test("orders staging and production as Convex, Worker, smoke, then app", () => {
    const staging = [
      controlPlane.indexOf("- name: Deploy Convex (staging deployment)"),
      controlPlane.indexOf("- name: Deploy control-plane Worker (staging)"),
      controlPlane.indexOf("  smoke-staging:"),
      controlPlane.indexOf("  deploy-app-staging:"),
    ]
    const production = [
      controlPlane.indexOf("- name: Deploy Convex (production deployment)"),
      controlPlane.indexOf("- name: Deploy control-plane Worker (production)"),
      controlPlane.indexOf("- name: Behavioral smoke (production)"),
      controlPlane.indexOf("  deploy-app-production:"),
    ]

    expect(staging.every((position) => position >= 0)).toBe(true)
    expect(production.every((position) => position >= 0)).toBe(true)
    expect(staging).toEqual([...staging].sort((left, right) => left - right))
    expect(production).toEqual([...production].sort((left, right) => left - right))
    expect(controlPlane).toContain("deploy-app-staging:\n    needs: smoke-staging")
    expect(controlPlane).toContain("promote-production:\n    if:")
    expect(controlPlane).toContain("needs: deploy-app-staging")
    expect(controlPlane).toContain("deploy-app-production:\n    if:")
    expect(controlPlane).toContain("needs: promote-production")
  })

  test("fails before Convex mutation when release configuration is incomplete", () => {
    expect(controlPlane.indexOf("- name: Verify ordered release configuration")).toBeLessThan(
      controlPlane.indexOf("- name: Deploy Convex (staging deployment)"),
    )
    expect(controlPlane.lastIndexOf("- name: Verify ordered release configuration")).toBeLessThan(
      controlPlane.indexOf("- name: Deploy Convex (production deployment)"),
    )
    expect(convex.indexOf("- name: Verify deployment configuration")).toBeLessThan(
      convex.indexOf("- name: Convex deploy"),
    )
    for (const name of [
      "CONVEX_DEPLOY_KEY",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLERK_SECRET_KEY",
      "CLAXEDO_RUNTIME_ADMIN_TOKEN",
      "CONTROL_PLANE_URL",
      "APP_URL",
      "PAGES_PROJECT",
      "PAGES_BRANCH",
      "CLERK_PUBLISHABLE_KEY",
      "CONVEX_URL",
    ]) {
      expect(controlPlane).toContain(name)
    }
  })

  test("prepares clean runners before native install, Convex packaging, and push routing", () => {
    expect(setupBun).toContain("npm install --global node-gyp@12.4.0")
    expect(setupBun.indexOf("npm install --global node-gyp@12.4.0")).toBeLessThan(
      setupBun.indexOf("bun install ${{ inputs.install-flags }}"),
    )
    const stagingBuild = controlPlane.indexOf("- name: Build WorkGraph packages for Convex")
    const stagingDryRun = controlPlane.indexOf("- name: Convex dry-run (config generation gate)")
    const productionBuild = controlPlane.lastIndexOf("- name: Build WorkGraph packages for Convex")
    const productionDryRun = controlPlane.lastIndexOf("- name: Convex dry-run (config generation gate)")
    expect(stagingBuild).toBeGreaterThanOrEqual(0)
    expect(stagingBuild).toBeLessThan(stagingDryRun)
    expect(productionBuild).toBeGreaterThan(stagingBuild)
    expect(productionBuild).toBeLessThan(productionDryRun)
    expect(appStaging).toContain('git cat-file -e "$BEFORE_SHA^{commit}"')
    expect(appStaging).toContain('git fetch --no-tags --depth=1 origin "$BEFORE_SHA"')
    expect(appStaging).toContain('git diff-tree --no-commit-id --name-only -r "$AFTER_SHA"')
    expect(controlPlane).toContain("- .github/actions/setup-bun/action.yml")
    expect(appStaging).toContain("- .github/actions/setup-bun/action.yml")
  })

  test("allows staging app deploys only through a lock-owning caller", () => {
    expect(app).not.toContain("workflow_dispatch:")
    expect(app).toContain("environment: ${{ inputs.target_environment }}")
    expect(appStaging).toContain("App deployment is delegated to the ordered control-plane workflow")
    expect(appStaging).toContain("uses: ./.github/workflows/deploy-claxedo-app.yml")
    expect(appStaging).toContain("target_environment: staging")
    expect(controlPlane).toContain("uses: ./.github/workflows/deploy-claxedo-app.yml")
    expect(controlPlane).toContain("target_environment: production")
    expect(convex).toContain("workflow_dispatch:")
    expect(convex).not.toContain("\n  push:")
    expect(app).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}")
    expect(app).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}")
  })

  test("runs one authenticated no-interception browser journey after every app deployment", () => {
    const appDeploy = app.indexOf("- name: Deploy app")
    const browserGate = app.indexOf("- name: Authenticated deployed WorkGraph browser gate")

    expect(appDeploy).toBeGreaterThanOrEqual(0)
    expect(browserGate).toBeGreaterThan(appDeploy)
    expect(app).toContain("run: bun run test:e2e:deployed-workgraph")
    expect(app).toContain("CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY }}")
    expect(app).toContain("WORKGRAPH_SMOKE_USER_A_ID: ${{ vars.WORKGRAPH_SMOKE_USER_A_ID }}")
    expect(app).toContain("WORKGRAPH_SMOKE_USER_A_EMAIL: ${{ vars.WORKGRAPH_SMOKE_USER_A_EMAIL }}")
    expect(app).toContain("WORKGRAPH_SMOKE_ORGANIZATION_A_ID: ${{ vars.WORKGRAPH_SMOKE_ORGANIZATION_A_ID }}")
    expect(deployedBrowser).toContain("clerk.signIn({ page, emailAddress: smokeEmail })")
    expect(deployedBrowser).toContain("await instance.setActive({ organization })")
    expect(deployedBrowser).toContain('await page.reload({ waitUntil: "domcontentloaded" })')
    expect(deployedBrowser).toContain("await page.setViewportSize({ width: 390, height: 844 })")
    expect(deployedBrowser).not.toContain("page.route(")
    expect(deployedBrowser).not.toContain("context.route(")
    expect(deployedBrowserConfig).toContain('args: ["--disable-blink-features=AutomationControlled"]')
    expect(appPlaywrightConfig).toContain('testIgnore: "**/deployed-workgraph.spec.ts"')
    expect(appPlaywrightConfig).toContain('testIgnore: ["**/mobile-*.spec.ts", "**/deployed-workgraph.spec.ts"]')
  })
})
