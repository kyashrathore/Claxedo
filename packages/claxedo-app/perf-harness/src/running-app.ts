import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import type { ReadinessTarget } from "./corpus"
import { launchClaxedo, type AppLaunch } from "./launch"
import type { MaterializedCorpus } from "./materialize"
import type { PackagedApp } from "./packaged-app"
import { controlScope, copyState, requireTarget } from "./prepared-state"
import { listedSessionIds, type RevealScope } from "./rail"
import { claxedoFacts, type Activation } from "./settle"
import type { OwnedProcess } from "./shutdown"

export class RunningApp {
  private readonly displayed = new Set<string>()

  private constructor(
    readonly launch: AppLaunch,
    readonly attemptDir: string,
    private readonly materialization: MaterializedCorpus,
  ) {
    this.displayed.add(requireTarget(materialization, "control").sessionId)
  }

  static async start(input: { app: PackagedApp; materialization: MaterializedCorpus; handle: string; attemptDir: string; log: (line: string) => void }) {
    await mkdir(path.dirname(input.attemptDir), { recursive: true, mode: 0o700 })
    await copyState(input.handle, input.attemptDir)
    const launch = await launchClaxedo({
      app: input.app,
      stateRoot: input.attemptDir,
      control: requireTarget(input.materialization, "control"),
      controlScope: controlScope(input.materialization),
      log: input.log,
    })
    return new RunningApp(launch, input.attemptDir, input.materialization)
  }

  target(logicalSessionId: string) {
    return requireTarget(this.materialization, logicalSessionId)
  }

  private scopeOf(target: ReadinessTarget): RevealScope {
    return { projectId: this.materialization.projects.get(target.workspaceId) }
  }

  wasDisplayed(target: ReadinessTarget) {
    return this.displayed.has(target.sessionId)
  }

  async hasMountedScreen(target: ReadinessTarget) {
    const mounted = await this.launch.page.evaluate(
      (sessionId: string) => !!document.querySelector(`section[data-component="session-screen"][data-session-id="${CSS.escape(sessionId)}"]`),
      target.sessionId,
    )
    return mounted === true
  }

  async isShowing(target: ReadinessTarget) {
    const facts = { sessionId: target.sessionId, latestTurnMessageIds: target.latestTurnMessageIds }
    const displayed = await this.launch.page.evaluateExpression(`(${claxedoFacts.toString()})(${JSON.stringify(facts)}).displayed()`)
    return displayed === true
  }

  async activate(target: ReadinessTarget): Promise<Activation> {
    const activation = await this.launch.activate(target, this.scopeOf(target))
    this.displayed.add(target.sessionId)
    return activation
  }

  async requireNextRowDown(source: ReadinessTarget, destination: ReadinessTarget) {
    const rows = await listedSessionIds(this.launch.page)
    const sourceRow = rows.indexOf(source.sessionId)
    if (sourceRow < 0 || rows[sourceRow + 1] !== destination.sessionId) {
      throw new Error(`Claxedo's row for ${destination.logicalSessionId} is not directly below ${source.logicalSessionId}'s (rows ${String(sourceRow)} → ${String(rows.indexOf(destination.sessionId))})`)
    }
  }

  async close(): Promise<{ terminated: OwnedProcess[]; survivors: OwnedProcess[] }> {
    const result = await this.launch.shutdown()
    if (result.survivors.length === 0) await rm(this.attemptDir, { recursive: true, force: true })
    return result
  }
}
