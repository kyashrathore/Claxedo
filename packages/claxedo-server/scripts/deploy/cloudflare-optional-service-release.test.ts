import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"

import {
  WranglerOptionalServiceRelease,
  type WranglerCommand,
  type WranglerCommandRunner,
} from "./cloudflare-optional-service-release"

class RecordingRunner implements WranglerCommandRunner {
  readonly commands: Array<{ command: WranglerCommand; config?: string }> = []

  async run(command: WranglerCommand) {
    const configIndex = command.args.indexOf("--config")
    this.commands.push({
      command,
      ...(configIndex >= 0 ? { config: await readFile(command.args[configIndex + 1]!, "utf8") } : {}),
    })
  }
}

function release(runner: RecordingRunner, retirement = true) {
  let exists = true
  return new WranglerOptionalServiceRelease({
    serviceWorkingDirectory: import.meta.dirname,
    coreWorkingDirectory: import.meta.dirname,
    runner,
    databaseBinding: "WORKGRAPH_DB",
    workerExists: async () => exists,
    renderServiceConfig: (input) => `name = ${JSON.stringify(input.workerName)}\ndatabase_id = ${JSON.stringify(input.databaseId)}\n`,
    ...(retirement
      ? {
          renderRetirementConfig: (input: { workerName: string }) =>
            `name = ${JSON.stringify(input.workerName)}\ndeleted_classes = ["WorkGraphSettler", "WorkGraphWakeLane"]\n`,
        }
      : {}),
    renderCoreConfig: (input) => `name = "core"\npresent = ${String(input.present)}\n`,
  })
}

describe("Wrangler optional-service release driver", () => {
  test("dry-runs then deploys a dark service and deploys exact binding presence", async () => {
    const runner = new RecordingRunner()
    const driver = release(runner)
    await driver.deployDark({
      serviceId: "workgraph",
      workerName: "claxedo-workgraph-production",
      databaseId: "11111111-1111-1111-1111-111111111111",
    })
    await driver.deployCoreBinding({
      serviceId: "workgraph",
      workerName: "claxedo-workgraph-production",
      descriptor: {} as never,
      present: true,
    })
    expect(runner.commands.map((item) => item.command.args.slice(0, 2))).toEqual([
      ["deploy", "--dry-run"],
      ["deploy", "--config"],
      ["deploy", "--config"],
    ])
    expect(runner.commands[0]?.config).toContain('name = "claxedo-workgraph-production"')
    expect(runner.commands[2]?.config).toContain("present = true")
  })

  test("lands WorkGraph deleted_classes before deleting its Worker", async () => {
    const runner = new RecordingRunner()
    await release(runner).deleteServiceWorker({
      serviceId: "workgraph",
      workerName: "claxedo-workgraph-production",
      databaseId: "11111111-1111-1111-1111-111111111111",
      retirementAuthorization: "archive:evidence-1",
    })
    expect(runner.commands).toHaveLength(2)
    expect(runner.commands[0]?.config).toContain("deleted_classes")
    expect(runner.commands[1]?.command.args).toEqual(["delete", "claxedo-workgraph-production"])
  })

  test("refuses WorkGraph deletion when no DO retirement artifact is wired", async () => {
    const runner = new RecordingRunner()
    await expect(
      release(runner, false).deleteServiceWorker({
        serviceId: "workgraph",
        workerName: "claxedo-workgraph-production",
        databaseId: "11111111-1111-1111-1111-111111111111",
        retirementAuthorization: "archive:evidence-1",
      }),
    ).rejects.toThrow(/deleted_classes/)
    expect(runner.commands).toEqual([])
  })
})
