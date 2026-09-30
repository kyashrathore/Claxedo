import type { PluginBackendActivation } from "./activations"

export type PluginRunPorts<Worker> = {
  readActivation(pluginId: string): Promise<PluginBackendActivation | undefined>
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
 * The runs of one organization's plugin backends: which activation each plugin
 * is running, the Worker loaded for it, and the facets it started.
 *
 * An activation is identified by its generation, the digest of its bundle hash
 * and manifest, so a manifest change is a new run just as a new bundle is.
 * Activation reads are applied in the order they started, so a slow read never
 * replaces a newer one. Replacing or ending a run aborts its facets, and work
 * that resumes after its run ended starts nothing on it.
 */
export class PluginBackendRuns<Worker> {
  readonly #runs = new Map<string, Run<Worker>>()
  readonly #applied = new Map<string, number>()
  #reads = 0

  constructor(private readonly ports: PluginRunPorts<Worker>) {}

  async current(pluginId: string): Promise<Run<Worker> | undefined> {
    const ticket = ++this.#reads
    const activation = await this.ports.readActivation(pluginId)
    if (ticket < (this.#applied.get(pluginId) ?? 0)) return this.#runs.get(pluginId)
    this.#applied.set(pluginId, ticket)
    const run = this.#runs.get(pluginId)
    if (run && run.activation.generation === activation?.generation) return run
    if (run) this.#end(pluginId, run)
    if (!activation) return undefined
    const next: Run<Worker> = { activation, live: true, facets: new Set() }
    this.#runs.set(pluginId, next)
    return next
  }

  async admits(pluginId: string, generation: string): Promise<boolean> {
    return (await this.current(pluginId))?.activation.generation === generation
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
    const reason = new Error(`plugin ${pluginId} is no longer running generation ${run.activation.generation}`)
    for (const facet of run.facets) this.ports.abortFacet(facet, reason)
  }
}
