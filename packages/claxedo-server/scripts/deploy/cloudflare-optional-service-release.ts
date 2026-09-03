import { rm, writeFile } from "node:fs/promises"
import path from "node:path"

import type { FirstPartyServiceDescriptor, FirstPartyServiceId } from "@claxedo/service-contract"

import type { CloudflareOptionalServiceRelease } from "../../src/platform/services/cloudflare-deployment-driver"

export type WranglerCommand = Readonly<{ args: readonly string[]; cwd: string }>

export interface WranglerCommandRunner {
  run(command: WranglerCommand): Promise<void>
}

export class BunWranglerCommandRunner implements WranglerCommandRunner {
  async run(command: WranglerCommand) {
    const child = Bun.spawn(["bun", "x", "wrangler", ...command.args], {
      cwd: command.cwd,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    })
    const exitCode = await child.exited
    if (exitCode !== 0) throw new Error(`wrangler ${command.args.join(" ")} exited with ${exitCode}`)
  }
}

type ServiceConfigInput = Readonly<{
  serviceId: FirstPartyServiceId
  workerName: string
  databaseId: string
  bucketName?: string
}>

export type WranglerOptionalServiceReleaseInput = Readonly<{
  serviceWorkingDirectory: string
  coreWorkingDirectory: string
  runner?: WranglerCommandRunner
  databaseBinding: "DOCUMENTS_DB"
  renderServiceConfig(input: ServiceConfigInput): string
  workerExists(workerName: string): Promise<boolean>
  renderCoreConfig(input: Readonly<{
    serviceId: FirstPartyServiceId
    descriptor: FirstPartyServiceDescriptor
    workerName: string
    present: boolean
  }>): Promise<string> | string
}>

/** Executes the exact rendered artifacts; environment variables never select a service implicitly. */
export class WranglerOptionalServiceRelease implements CloudflareOptionalServiceRelease {
  private readonly runner: WranglerCommandRunner

  constructor(private readonly input: WranglerOptionalServiceReleaseInput) {
    this.runner = input.runner ?? new BunWranglerCommandRunner()
  }

  async applyMigrations(input: ServiceConfigInput) {
    await this.withConfig(this.input.renderServiceConfig(input), "service", this.input.serviceWorkingDirectory, (config) =>
      this.runner.run({
        cwd: this.input.serviceWorkingDirectory,
        args: ["d1", "migrations", "apply", this.input.databaseBinding, "--remote", "--config", config],
      }),
    )
  }

  async deployDark(input: ServiceConfigInput) {
    await this.withConfig(this.input.renderServiceConfig(input), "service", this.input.serviceWorkingDirectory, async (config) => {
      await this.runner.run({
        cwd: this.input.serviceWorkingDirectory,
        args: ["deploy", "--dry-run", "--config", config],
      })
      await this.runner.run({ cwd: this.input.serviceWorkingDirectory, args: ["deploy", "--config", config] })
    })
  }

  async deployCoreBinding(input: {
    serviceId: FirstPartyServiceId
    descriptor: FirstPartyServiceDescriptor
    workerName: string
    present: boolean
  }) {
    const configText = await this.input.renderCoreConfig(input)
    await this.withConfig(configText, "core", this.input.coreWorkingDirectory, (config) =>
      this.runner.run({ cwd: this.input.coreWorkingDirectory, args: ["deploy", "--config", config] }),
    )
  }

  async deleteServiceWorker(input: {
    serviceId: FirstPartyServiceId
    workerName: string
    databaseId: string
    bucketName?: string
    retirementAuthorization: string
  }) {
    if (!input.retirementAuthorization.trim()) throw new Error("retirementAuthorization is required")
    if (!(await this.input.workerExists(input.workerName))) return
    try {
      await this.runner.run({
        cwd: this.input.serviceWorkingDirectory,
        args: ["delete", input.workerName],
      })
    } catch (error) {
      if (await this.input.workerExists(input.workerName)) throw error
    }
  }

  private async withConfig<T>(
    contents: string,
    owner: "service" | "core",
    workingDirectory: string,
    work: (path: string) => Promise<T>,
  ) {
    const config = path.join(workingDirectory, `.claxedo-${owner}-${crypto.randomUUID()}.toml`)
    try {
      await writeFile(config, contents, { encoding: "utf8", mode: 0o600, flag: "wx" })
      return await work(config)
    } finally {
      await rm(config, { force: true })
    }
  }
}
