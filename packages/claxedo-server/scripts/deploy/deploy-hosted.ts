import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveDeploymentProfileFromEnv } from "../../src/deployments/hosted-shared/deployment-profile"
import { betterAuthD1ReleaseInputs } from "./release-better-auth-d1"

const serverRoot = path.resolve(import.meta.dirname, "../..")
const repoRoot = path.resolve(serverRoot, "../..")
const appRoot = path.join(repoRoot, "packages/claxedo-app")
const sandboxScriptsRoot = path.join(serverRoot, "scripts/sandbox")
const cloudflareSandboxRoot = path.join(sandboxScriptsRoot, "cloudflare-worker")

type Target = "central" | "app" | "cloudflare-sandbox"
type Command = {
  name: string
  cwd: string
  cmd: string
  args: string[]
  env?: Record<string, string>
}

function clean(value: string | undefined) {
  return value?.trim() || undefined
}

function targets(args = process.argv, fallback = "central,app") {
  const targetFlag = args.findIndex((arg) => arg === "--target" || arg === "--targets")
  const input =
    clean(process.env.CLAXEDO_DEPLOY_TARGETS) ??
    args.find((arg) => arg.startsWith("--targets="))?.slice("--targets=".length) ??
    args.find((arg) => arg.startsWith("--target="))?.slice("--target=".length) ??
    (targetFlag >= 0 ? args[targetFlag + 1] : undefined) ??
    fallback
  return input.split(",").map((item) => {
    const target = item.trim()
    if (target === "central" || target === "app" || target === "cloudflare-sandbox") return target
    throw new Error(`Unknown deploy target: ${target}`)
  })
}

export function hostedDeployCommands(input: {
  staging: boolean
  dryRun: boolean
  targets: Target[]
  env?: NodeJS.ProcessEnv
}): Command[] {
  const env = input.env ?? process.env
  const profile = resolveDeploymentProfileFromEnv(env)
  if (profile.adapterProfile === "better-auth-d1" && input.targets.some((target) => target !== "central")) {
    throw new Error("the Better Auth D1 locked composition supports only the central target")
  }
  return input.targets.flatMap((target): Command[] => {
    if (target === "central") {
      if (profile.adapterProfile === "better-auth-d1") {
        betterAuthD1ReleaseInputs(env, input.staging ? "staging" : "production")
        return [
          {
            name: input.dryRun ? "better_auth_d1.release.preflight" : "better_auth_d1.release.deploy",
            cwd: serverRoot,
            cmd: "bun",
            args: [
              "run",
              "scripts/deploy/release-better-auth-d1.ts",
              ...(input.staging ? ["--staging"] : []),
              ...(!input.dryRun ? ["--deploy"] : []),
            ],
          },
        ]
      }
      return [
        {
          name: input.dryRun ? "central.worker.dry_run" : "central.worker.deploy",
          cwd: serverRoot,
          cmd: "wrangler",
          args: [
            "deploy",
            "--env",
            input.staging ? "staging" : "",
            ...(input.dryRun ? ["--dry-run", "--outdir", "dist-worker"] : []),
          ],
        },
      ]
    }
    if (target === "app") {
      return [
        {
          name: "app.assets.build",
          cwd: appRoot,
          cmd: "bun",
          args: ["run", "build"],
          env: {
            VITE_CLAXEDO_SERVER_URL: clean(env.CLAXEDO_CENTRAL_URL) ?? "",
            VITE_AUTH_ENABLED: "true",
            VITE_CLAXEDO_PRODUCT_POSTURE: profile.productPosture,
            VITE_CLAXEDO_AUTH_ADAPTER: profile.authAdapter,
            ...(profile.adapterProfile === "clerk-convex" && clean(env.VITE_CLERK_PUBLISHABLE_KEY)
              ? { VITE_CLERK_PUBLISHABLE_KEY: clean(env.VITE_CLERK_PUBLISHABLE_KEY)! }
              : {}),
            ...(profile.adapterProfile === "clerk-convex" && clean(env.VITE_CONVEX_URL)
              ? { VITE_CONVEX_URL: clean(env.VITE_CONVEX_URL)! }
              : {}),
          },
        },
        ...(input.dryRun
          ? []
          : [
              {
                name: "app.pages.deploy",
                cwd: appRoot,
                cmd: "wrangler",
                args: [
                  "pages",
                  "deploy",
                  "dist",
                  "--project-name",
                  clean(env.CLAXEDO_PAGES_PROJECT) ?? "claxedo-app-staging",
                  "--branch",
                  input.staging ? "staging" : "dev",
                ],
              },
            ]),
      ]
    }
    if (target === "cloudflare-sandbox") {
      if (profile.sandboxPosture !== "full-hosted" || profile.sandboxDriver !== "cloudflare") {
        throw new Error("cloudflare-sandbox target requires the full-hosted Cloudflare sandbox profile")
      }
      // Bundle the in-repo workspace-runtime host into the wrangler build
      // context (.build/) — the Dockerfile COPYs it. Replaces the old
      // npm-view publish gate: images build from the repo, not from npm.
      const bundleHost = {
        name: "cloudflare_sandbox.bundle_host",
        cwd: sandboxScriptsRoot,
        cmd: "npx",
        args: ["tsx", "build-sandbox-image.ts", "--bundle-only", `--out=${path.join(cloudflareSandboxRoot, ".build")}`],
      }
      return input.dryRun
        ? [
            bundleHost,
            {
              name: "cloudflare_sandbox.worker.dry_run",
              cwd: cloudflareSandboxRoot,
              cmd: "wrangler",
              args: ["deploy", "--dry-run"],
            },
          ]
        : [
            bundleHost,
            { name: "cloudflare_sandbox.dependencies", cwd: cloudflareSandboxRoot, cmd: "npm", args: ["ci"] },
            {
              name: "cloudflare_sandbox.worker.deploy",
              cwd: cloudflareSandboxRoot,
              cmd: "npm",
              args: ["run", "deploy"],
            },
          ]
    }
    throw new Error(`Unknown deploy target: ${target}`)
  })
}

async function run(command: Command) {
  console.log(`${command.name}: running ${[command.cmd, ...command.args].join(" ")}`)
  const child = spawn(command.cmd, command.args, {
    cwd: command.cwd,
    env: command.env ? { ...process.env, ...command.env } : process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  if (code !== 0) {
    console.error(`${command.name}: failed`)
    process.exit(code ?? 1)
  }
  console.log(`${command.name}: succeeded`)
}

/**
 * Surface the sandbox build identity (written by build-sandbox-image.ts to
 * scripts/sandbox/.build/build-info.json) so operators can pin the control
 * plane to the exact build. Deleting the npm-publish gate removed content
 * immutability at a fixed core version, so the same version can now map to
 * different bundles — set CLAXEDO_SANDBOX_BUILD_ID (or CLAXEDO_SNAPSHOT_NAME /
 * CLAXEDO_SANDBOX_IMAGE) on the control plane to the value printed here.
 */
function printSandboxBuildInfo() {
  const infoPath = path.join(sandboxScriptsRoot, ".build", "build-info.json")
  if (!fs.existsSync(infoPath)) return
  try {
    const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as {
      imageTag?: string
      snapshotName?: string
      buildId?: string
      coreVersion?: string
    }
    console.log("")
    console.log("=== sandbox build identity (build-info.json) ===")
    console.log(`  core version:  ${info.coreVersion ?? "?"}`)
    console.log(`  build id:      ${info.buildId ?? "?"}`)
    console.log(`  image tag:     ${info.imageTag ?? "?"}`)
    console.log(`  snapshot name: ${info.snapshotName ?? "?"}`)
    console.log(`  -> pin the control plane with CLAXEDO_SANDBOX_BUILD_ID=${info.buildId ?? "<id>"}`)
    console.log(`     (or CLAXEDO_SNAPSHOT_NAME / CLAXEDO_SANDBOX_IMAGE to override names outright)`)
    console.log("================================================")
    console.log("")
  } catch (err) {
    console.warn(`[deploy-hosted] could not read sandbox build-info: ${(err as Error).message}`)
  }
}

async function main() {
  const dryRun = !process.argv.includes("--deploy")
  const profile = resolveDeploymentProfileFromEnv(process.env)
  const requestedTargets = targets(
    process.argv,
    profile.adapterProfile === "better-auth-d1" ? "central" : "central,app",
  )
  const commands = hostedDeployCommands({
    staging: process.argv.includes("--staging"),
    dryRun,
    targets: requestedTargets,
  })
  for (const command of commands) {
    await run(command)
    // After the sandbox host bundle is built, print the resulting build
    // identity so operators can wire it onto the control plane.
    if (command.name === "cloudflare_sandbox.bundle_host") printSandboxBuildInfo()
  }
  console.log(dryRun ? "hosted deploy dry-run succeeded" : "hosted deploy succeeded")
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await main()
}
