import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { migrationStatusDecision, parseMigrationWaitArgs } from "../../../../scripts/wait-for-convex-migrations"

const root = path.resolve(import.meta.dirname, "../../../..")
const controlPlane = fs.readFileSync(path.join(root, ".github/workflows/deploy-control-plane.yml"), "utf8")
const convex = fs.readFileSync(path.join(root, ".github/workflows/deploy-convex.yml"), "utf8")
const app = fs.readFileSync(path.join(root, ".github/workflows/deploy-claxedo-app.yml"), "utf8")
const appStaging = fs.readFileSync(path.join(root, ".github/workflows/deploy-claxedo-app-staging.yml"), "utf8")
const sandboxImage = fs.readFileSync(path.join(root, ".github/workflows/claxedo-sandbox-image.yml"), "utf8")
const sandboxWorker = fs.readFileSync(path.join(root, ".github/workflows/deploy-cloudflare-sandbox-worker.yml"), "utf8")
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
  test("the migration waiter fails closed and completes only on successful terminal states", () => {
    const names = ["migrations:first", "migrations:second"]
    expect(
      migrationStatusDecision(names, [
        { name: names[0], state: "success", isDone: true },
        { name: names[1], state: "inProgress", isDone: false },
      ]),
    ).toBe(false)
    expect(
      migrationStatusDecision(
        names,
        names.map((name) => ({ name, state: "success", isDone: true })),
      ),
    ).toBe(true)
    expect(() => migrationStatusDecision(names, [{ name: names[0], state: "success", isDone: true }])).toThrow(
      "incomplete migration status set",
    )
    expect(() =>
      migrationStatusDecision(
        names,
        names.map(() => ({
          name: names[0],
          state: "success",
          isDone: true,
        })),
      ),
    ).toThrow("mismatched migration status set")
    expect(() =>
      migrationStatusDecision(names, [
        { name: names[0], state: "success", isDone: true },
        { name: names[1], state: "failed", isDone: false, error: "contract violation" },
      ]),
    ).toThrow("contract violation")
  })

  test("the migration waiter keeps deployment selectors out of migration names", () => {
    expect(parseMigrationWaitArgs(["--deployment", "staging", "migrations:first"])).toEqual({
      names: ["migrations:first"],
      deploymentArgs: ["--deployment", "staging"],
    })
    expect(parseMigrationWaitArgs(["--prod", "migrations:first"])).toEqual({
      names: ["migrations:first"],
      deploymentArgs: ["--prod"],
    })
    expect(() => parseMigrationWaitArgs(["--deployment", "migrations:first"])).toThrow("requires a deployment name")
    expect(() => parseMigrationWaitArgs(["--deployment", "staging", "--prod", "migrations:first"])).toThrow(
      "exactly one Convex deployment selector",
    )
    expect(() => parseMigrationWaitArgs(["--unknown", "migrations:first"])).toThrow("Unknown option")
  })

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

  test("orders staging and production as Convex, relay, control plane, smoke, then app", () => {
    const staging = [
      controlPlane.indexOf("- name: Deploy Convex (staging deployment)"),
      controlPlane.indexOf("- name: Normalize legacy runtime lease fields (staging)"),
      controlPlane.indexOf("- name: Backfill tenant identity contracts (staging)"),
      controlPlane.indexOf("- name: Verify tenant identity contracts (staging)"),
      controlPlane.indexOf("- name: Legacy Session tenant migration smoke (staging)"),
      controlPlane.indexOf("- name: Deploy workspace relay Worker (staging)"),
      controlPlane.indexOf("- name: Deploy control-plane Worker (staging)"),
      controlPlane.indexOf("  smoke-staging:"),
      controlPlane.indexOf("  deploy-app-staging:"),
    ]
    const production = [
      controlPlane.indexOf("- name: Deploy Convex (production deployment)"),
      controlPlane.indexOf("- name: Normalize legacy runtime lease fields (production)"),
      controlPlane.indexOf("- name: Backfill tenant identity contracts (production)"),
      controlPlane.indexOf("- name: Verify tenant identity contracts (production)"),
      controlPlane.indexOf("- name: Legacy Session tenant migration smoke (production)"),
      controlPlane.indexOf("- name: Deploy workspace relay Worker (production)"),
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
    expect(controlPlane).toContain("needs: [deploy-app-staging, build_sandbox_runtime]")
    expect(controlPlane).toContain("deploy-app-production:\n    if:")
    expect(controlPlane).toContain("needs: promote-production")
  })

  test("gates relay publication on all tenant backfills, verifiers, and a legacy Session canary", () => {
    for (const migration of [
      "backfillUserActorIdentity",
      "backfillProjectTenantIdentity",
      "reconcileProjectMembershipProjectIds",
      "backfillWorkspaceTenantIdentity",
      "backfillSessionTenantIdentity",
      "backfillDefaultTeams",
      "backfillDefaultTeamMemberships",
      "backfillDefaultTeamProjectGrants",
      "backfillDefaultTeamWorkspaceShares",
      "backfillDefaultTeamSessionShares",
      "verifyUserActorIdentityContract",
      "verifyProjectTenantIdentityContract",
      "verifyProjectMembershipIdentityContract",
      "verifyWorkspaceTenantIdentityContract",
      "verifySessionTenantIdentityContract",
    ])
      expect(controlPlane.match(new RegExp(migration, "g"))?.length).toBe(4)
    expect(controlPlane.match(/TENANT_MIGRATION_LEGACY_SESSION_ID/g)?.length).toBeGreaterThanOrEqual(5)
    expect(controlPlane).toContain("legacy_session_tenant_mismatch")
  })

  test("waits for every asynchronous tenant migration before advancing the release gate", () => {
    const stagingWaits = [
      "bun scripts/wait-for-convex-migrations.ts --deployment staging migrations:normalizeRuntimeLeaseLegacyFields",
      "bun scripts/wait-for-convex-migrations.ts --deployment staging migrations:backfillUserActorIdentity migrations:backfillProjectTenantIdentity migrations:reconcileProjectMembershipProjectIds migrations:backfillWorkspaceTenantIdentity migrations:backfillSessionTenantIdentity",
      "bun scripts/wait-for-convex-migrations.ts --deployment staging migrations:backfillDefaultTeams migrations:backfillDefaultTeamMemberships migrations:backfillDefaultTeamProjectGrants migrations:backfillDefaultTeamWorkspaceShares migrations:backfillDefaultTeamSessionShares",
      "bun scripts/wait-for-convex-migrations.ts --deployment staging migrations:verifyUserActorIdentityContract migrations:verifyProjectTenantIdentityContract migrations:verifyProjectMembershipIdentityContract migrations:verifyWorkspaceTenantIdentityContract migrations:verifySessionTenantIdentityContract",
    ]
    const productionWaits = stagingWaits.map((command) => command.replace("--deployment staging", "--prod"))
    for (const command of [...stagingWaits, ...productionWaits]) {
      expect(controlPlane).toContain(command)
    }
    expect(controlPlane.indexOf(stagingWaits[0]!)).toBeLessThan(
      controlPlane.indexOf("- name: Backfill tenant identity contracts (staging)"),
    )
    expect(controlPlane.indexOf(stagingWaits[1]!)).toBeLessThan(
      controlPlane.indexOf("- name: Backfill default team projections (staging)"),
    )
    expect(controlPlane.indexOf(stagingWaits[2]!)).toBeLessThan(
      controlPlane.indexOf("- name: Verify tenant identity contracts (staging)"),
    )
    expect(controlPlane.indexOf(stagingWaits[3]!)).toBeLessThan(
      controlPlane.indexOf("- name: Legacy Session tenant migration smoke (staging)"),
    )
    expect(controlPlane.match(/"reset":true/g)).toHaveLength(8)
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
      "CLERK_WEBHOOK_SECRET",
      "CLAXEDO_RUNTIME_ADMIN_TOKEN",
      "CONTROL_PLANE_URL",
      "WORKSPACE_RELAY_URL",
      "SANDBOX_BUILD_ID",
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
    const stagingWorkspaceBuild = controlPlane.indexOf("- name: Build control-plane workspace packages")
    const stagingWorker = controlPlane.indexOf("- name: Deploy control-plane Worker (staging)")
    const appWorkGraphBuild = app.indexOf("- name: Build WorkGraph dependency closure for app")
    const appBuild = app.indexOf("- name: Build app for the verified control plane")
    const productionBuild = controlPlane.lastIndexOf("- name: Build WorkGraph packages for Convex")
    const productionDryRun = controlPlane.lastIndexOf("- name: Convex dry-run (config generation gate)")
    const productionWorkspaceBuild = controlPlane.lastIndexOf("- name: Build control-plane workspace packages")
    const productionWorker = controlPlane.indexOf("- name: Deploy control-plane Worker (production)")
    expect(stagingWorkspaceBuild).toBeGreaterThanOrEqual(0)
    expect(stagingWorkspaceBuild).toBeLessThan(stagingWorker)
    expect(stagingBuild).toBeGreaterThanOrEqual(0)
    expect(stagingBuild).toBeLessThan(stagingDryRun)
    expect(productionBuild).toBeGreaterThan(stagingBuild)
    expect(productionBuild).toBeLessThan(productionDryRun)
    expect(productionWorkspaceBuild).toBeGreaterThan(stagingWorkspaceBuild)
    expect(productionWorkspaceBuild).toBeLessThan(productionWorker)
    expect(appWorkGraphBuild).toBeGreaterThanOrEqual(0)
    expect(appWorkGraphBuild).toBeLessThan(appBuild)
    for (const command of [
      "bun run --cwd packages/workspace-relay-protocol build",
      "bun run --cwd packages/workspace-relay build",
      "bun run --cwd packages/claxedo-connections build",
    ]) {
      expect(controlPlane.match(new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(2)
    }
    expect(controlPlane.match(/bun run --cwd packages\/sandbox-manager build/g)).toHaveLength(3)
    expect(appStaging).toContain('git cat-file -e "$BEFORE_SHA^{commit}"')
    expect(appStaging).toContain('git fetch --no-tags --depth=1 origin "$BEFORE_SHA"')
    expect(appStaging).toContain('git diff-tree --no-commit-id --name-only -r "$AFTER_SHA"')
    expect(sandboxImage.indexOf("- name: Build sandbox packages")).toBeLessThan(
      sandboxImage.indexOf("- name: Build and push sandbox image"),
    )
    const sandboxContractBuild = sandboxImage.indexOf("bun run --cwd packages/sandbox-contract build")
    const sandboxManagerBuild = sandboxImage.indexOf("bun run --cwd packages/sandbox-manager build")
    expect(sandboxContractBuild).toBeGreaterThanOrEqual(0)
    expect(sandboxContractBuild).toBeLessThan(sandboxManagerBuild)
    expect(sandboxImage).toContain("- packages/sandbox-manager/**")
    expect(sandboxImage).not.toContain("- packages/sandbox-manager/src/image.ts")
    expect(sandboxWorker).toContain("npx tsx ../build-sandbox-image.ts --bundle-only --out=.build")
    expect(sandboxWorker).toContain("bun run --cwd ../../../../sandbox-manager build")
    expect(sandboxWorker).toContain("synchronize-control-token:")
    expect(sandboxWorker).toContain("environment: staging")
    expect(sandboxWorker).toContain("npx --yes wrangler@4.50.0 secret put API_TOKEN")
    expect(sandboxWorker).toContain("SANDBOX_CONTROL_TOKEN: ${{ secrets.CLAXEDO_RUNTIME_ADMIN_TOKEN }}")
    expect(controlPlane).toContain("wrangler secret put CLOUDFLARE_SANDBOX_API_TOKEN --env staging")
    expect(controlPlane).toContain('convex env set CLERK_WEBHOOK_SECRET "$CLERK_WEBHOOK_SECRET"')
    expect(controlPlane.match(/run: bun run scripts\/smoke\/sync-clerk-workgraph-fixtures\.ts/g)).toHaveLength(2)
    // 3 vs 2 is deliberate, not drift: staging and prod each run the WorkGraph
    // smoke (which needs both vars — `smoke-workgraph.ts` requires
    // REPOSITORY_URL *and* BASE_REVISION), and staging additionally runs the
    // "Interactive hosted Session smoke", whose `smoke-interactive-session.ts`
    // requires only REPOSITORY_URL. Adding a BASE_REVISION to that step to make
    // the counts match would assert an env var the script never reads.
    expect(
      controlPlane.match(
        /WORKGRAPH_SMOKE_REPOSITORY_URL: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\.git/g,
      ),
    ).toHaveLength(3)
    expect(controlPlane.match(/WORKGRAPH_SMOKE_BASE_REVISION: \$\{\{ github\.sha \}\}/g)).toHaveLength(2)
    expect(controlPlane).toContain("working-directory: packages/workspace-relay")
    expect(controlPlane).toContain('wrangler deploy --env staging --var "CLAXEDO_RELEASE:${GITHUB_SHA}"')
    expect(controlPlane.match(/--var "CLAXEDO_PUBLIC_URL:\$\{CONTROL_PLANE_URL\}"/g)).toHaveLength(2)
    expect(controlPlane).toContain('--var "CLAXEDO_WORKSPACE_RELAY_URL:${WORKSPACE_RELAY_URL}"')
    expect(controlPlane).toContain("build_sandbox_runtime:")
    expect(controlPlane).toContain("bun run --cwd packages/claxedo-server sandbox:image --push")
    expect(controlPlane).toContain("build_id: ${{ steps.sandbox_identity.outputs.build_id }}")
    expect(
      controlPlane.match(/SANDBOX_BUILD_ID: \$\{\{ needs\.build_sandbox_runtime\.outputs\.build_id \}\}/g),
    ).toHaveLength(4)
    expect(controlPlane).not.toContain("vars.CLAXEDO_SANDBOX_BUILD_ID")
    expect(controlPlane.match(/--var "CLAXEDO_SANDBOX_BUILD_ID:\$\{SANDBOX_BUILD_ID\}"/g)).toHaveLength(2)
    expect(controlPlane.match(/WORKSPACE_RELAY_URL SANDBOX_BUILD_ID/g)).toHaveLength(2)
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
    expect(app).toContain("WORKGRAPH_SMOKE_REPOSITORY_URL: ${{ github.server_url }}/${{ github.repository }}.git")
    expect(app).toContain("WORKGRAPH_SMOKE_BASE_REVISION: ${{ github.sha }}")
    expect(deployedBrowser).toContain("clerk.signIn({ page, emailAddress: smokeEmail })")
    expect(deployedBrowser).toContain("await instance.setActive({ organization })")
    expect(deployedBrowser).toContain("scope.__CLAXEDO_CLERK_TESTING__ = true")
    expect(deployedBrowser).not.toContain('document.createElement("script")')
    expect(deployedBrowser).not.toContain('required("CLERK_FAPI")')
    expect(deployedBrowser).toContain('await page.reload({ waitUntil: "domcontentloaded" })')
    expect(deployedBrowser).toContain("await page.setViewportSize({ width: 390, height: 844 })")
    expect(deployedBrowser).not.toContain("page.route(")
    expect(deployedBrowser).not.toContain("context.route(")
    expect(deployedBrowserConfig).toContain('args: ["--disable-blink-features=AutomationControlled"]')
    expect(appPlaywrightConfig.match(/"\*\*\/deployed-workgraph\.spec\.ts"/g)).toHaveLength(3)
    expect(appPlaywrightConfig.match(/"\*\*\/desktop-\*\.spec\.ts"/g)).toHaveLength(2)
    expect(appPlaywrightConfig).toContain(
      'process.env.CLAXEDO_E2E_DESKTOP === "1" ? [] : ["**/desktop-*.spec.ts", "**/real-desktop-*.spec.ts"]',
    )
  })
})
