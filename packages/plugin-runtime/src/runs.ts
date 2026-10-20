import type { PluginBackendActivation, PluginBackendState } from "./host-port"

export type PluginRunPorts<Worker> = {
  readState(): Promise<PluginBackendState>
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
 * The runs of one plugin's backend in one organization: which activation
 * epoch it is running, the Worker loaded for it, and the facets it started.
 *
 * Epochs only rise, so a read carrying an older epoch than one already applied
 * is stale and changes nothing. A newer epoch ends the run, aborting its
 * facets, and work that resumes after its run ended starts nothing on it.
 */
export class PluginBackendRuns<Worker> {
  #run: Run<Worker> | undefined
  #epoch = 0

  constructor(private readonly ports: PluginRunPorts<Worker>) {}

  async current(): Promise<Run<Worker> | undefined> {
    const state = await this.ports.readState()
    if (state.epoch < this.#epoch) return this.#run
    this.#epoch = state.epoch
    const run = this.#run
    if (run && run.activation.epoch === state.epoch) return run
    if (run) this.#end(run)
    if (!state.activation) return undefined
    const next: Run<Worker> = { activation: state.activation, live: true, facets: new Set() }
    this.#run = next
    return next
  }

  async admits(epoch: number): Promise<boolean> {
    return (await this.current())?.activation.epoch === epoch
  }

  async dispatch<Answer>(dispatch: PluginDispatch<Worker, Answer>): Promise<Answer> {
    for (let attempt = 0; attempt < DISPATCH_ATTEMPTS; attempt++) {
      const run = await this.current()
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

  #end(run: Run<Worker>) {
    run.live = false
    this.#run = undefined
    const reason = new Error(`plugin ${run.activation.manifest.id} is no longer running epoch ${run.activation.epoch}`)
    for (const facet of run.facets) this.ports.abortFacet(facet, reason)
  }
}
