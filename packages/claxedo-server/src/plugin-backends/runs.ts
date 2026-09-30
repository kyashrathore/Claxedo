import type { PluginBackendActivation, PluginBackendState } from "./activations"

export type PluginRunPorts<Worker> = {
  readState(pluginId: string): Promise<PluginBackendState>
  loadWorker(activation: PluginBackendActivation): Promise<Worker | undefined>
  abortFacet(facet: string, reason: Error): void
}

export type PluginDispatch<Worker, Answer> = {
  /** A refusal decided from the activation alone, before the bundle is read. */
  refuse(activation: PluginBackendActivation): Answer | undefined
  /**
   * Called only while the run is current, and synchronously after that check,
   * so every facet it starts through `track` belongs to the live run.
   */
  send(worker: Worker, activation: PluginBackendActivation, track: (facet: string) => void): Answer | Promise<Answer>
  inactive(): Answer
  unavailable(): Answer
  changing(): Answer
}

type Run<Worker> = {
  activation: PluginBackendActivation
  live: boolean
  worker?: Promise<Worker | undefined>
  facets: Set<string>
}

const DISPATCH_ATTEMPTS = 3

/**
 * The runs of one organization's plugin backends: which activation epoch each
 * plugin is running, the Worker loaded for it, and the facets it started.
 *
 * Epochs only rise, so a read carrying an older epoch than one already applied
 * is stale and changes nothing. A newer epoch ends the run, aborting its
 * facets, and work that resumes after its run ended starts nothing on it.
 */
export class PluginBackendRuns<Worker> {
  readonly #runs = new Map<string, Run<Worker>>()
  readonly #epochs = new Map<string, number>()

  constructor(private readonly ports: PluginRunPorts<Worker>) {}

  async current(pluginId: string): Promise<Run<Worker> | undefined> {
    const state = await this.ports.readState(pluginId)
    if (state.epoch < (this.#epochs.get(pluginId) ?? 0)) return this.#runs.get(pluginId)
    this.#epochs.set(pluginId, state.epoch)
    const run = this.#runs.get(pluginId)
    if (run && run.activation.epoch === state.epoch) return run
    if (run) this.#end(pluginId, run)
    if (!state.activation) return undefined
    const next: Run<Worker> = { activation: state.activation, live: true, facets: new Set() }
    this.#runs.set(pluginId, next)
    return next
  }

  async admits(pluginId: string, epoch: number): Promise<boolean> {
    return (await this.current(pluginId))?.activation.epoch === epoch
  }

  async dispatch<Answer>(pluginId: string, dispatch: PluginDispatch<Worker, Answer>): Promise<Answer> {
    for (let attempt = 0; attempt < DISPATCH_ATTEMPTS; attempt++) {
      const run = await this.current(pluginId)
      if (!run) return dispatch.inactive()
      const refused = dispatch.refuse(run.activation)
      if (refused !== undefined) return refused
      const worker = await this.#worker(run)
      if (!run.live) continue
      if (!worker) return dispatch.unavailable()
      return dispatch.send(worker, run.activation, (facet) => run.facets.add(facet))
    }
    return dispatch.changing()
  }

  async #worker(run: Run<Worker>): Promise<Worker | undefined> {
    const loading = (run.worker ??= this.ports.loadWorker(run.activation))
    const worker = await loading.catch((error: unknown) => {
      if (run.worker === loading) run.worker = undefined
      throw error
    })
    if (!worker && run.worker === loading) run.worker = undefined
    return worker
  }

  #end(pluginId: string, run: Run<Worker>) {
    run.live = false
    this.#runs.delete(pluginId)
    const reason = new Error(`plugin ${pluginId} is no longer running epoch ${run.activation.epoch}`)
    for (const facet of run.facets) this.ports.abortFacet(facet, reason)
  }
}
