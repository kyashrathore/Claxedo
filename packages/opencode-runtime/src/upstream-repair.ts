/**
 * Repairs one defect in the published `@opencode-ai/core` BUILD OUTPUT.
 *
 * What is broken (root cause, verified — contract doc §2.4):
 *
 *   `core/src/filesystem.ts` and `core/src/filesystem/search.ts` import each
 *   other. Run as ESM source the cycle is benign: `search.ts` only touches the
 *   `FileSystem` namespace lazily, inside layer bodies. But core is published
 *   through `Bun.build({ splitting: true })`, which linearises both modules
 *   into ONE chunk and emits `filesystem.ts` FIRST. Its top-level
 *
 *       export const node = makeLocationNode({ ..., deps: [..., FileSystemSearch.node] })
 *
 *   then reads the search namespace ~150 lines before the search module runs,
 *   and a bundled namespace object yields `undefined` rather than throwing a
 *   TDZ error. So `FileSystem.node.dependencies[2] === undefined`.
 *
 * What that costs: every request whose layer tree reaches `@opencode/FileSystem`
 * dies in `LayerNode.walk` with `TypeError: undefined is not an object
 * (evaluating 'node.name')`, which the Effect router turns into a 500 with an
 * empty body. That is `config.get`, `agent.list`, `provider.list`,
 * `plugin.list` and `session.prompt` — i.e. the whole product. Only calls that
 * never resolve a location survive, which is why the SDK's own
 * `verify-package.ts` (it asserts `health.get()` alone) ships this green.
 *
 * Why repair here rather than fork: the defect is a single missing array
 * element in a plain object created at module scope. Re-pointing it at the
 * node it was always meant to hold restores exactly upstream's source
 * behaviour, needs no vendored tarball, no patched `node_modules`, and no
 * second copy of the engine. `@opencode-ai/core` is a declared dependency at
 * the same pinned version and the same integrity hash the SDK already
 * resolves, so this adds no new supply-chain surface.
 *
 * How this module gets DELETED: `upstream-repair.test.ts` asserts the defect
 * is still present in the installed core. When upstream fixes the cycle and we
 * bump the pin, that test fails — and the failure message says to delete this
 * file, its test, the `@opencode-ai/core` dependency and the `boot()` call.
 * The upstream fix is one line, kept at
 * `contract/upstream-core-cycle.patch`.
 */
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"

/** Service keys the repair is written against. A change here means re-verify. */
const FILESYSTEM_NODE = "@opencode/FileSystem"
const SEARCH_NODE = "@opencode/FileSystem/Search"

export type RepairOutcome =
  /** The defect was present and has now been repaired. */
  | Readonly<{ repaired: true; node: string; dependency: string; index: number }>
  /** This process already repaired the graph; the second call is a no-op. */
  | Readonly<{ repaired: false; reason: "already-repaired" }>
  /** The graph was sound on first inspection. This module is dead weight. */
  | Readonly<{ repaired: false; reason: "upstream-fixed" }>

export class UpstreamShapeError extends Error {
  readonly code = "upstream_shape_changed"
  constructor(detail: string) {
    super(
      `The @opencode-ai/core layer graph no longer matches what upstream-repair.ts was verified against: ${detail}. ` +
        `Re-verify against the installed core before shipping; do not guess.`,
    )
    this.name = "UpstreamShapeError"
  }
}

/** Set once the graph has been repaired, so a second call cannot misreport. */
let repairedThisProcess = false

/**
 * Idempotent, and honest about which of the two "nothing to do" cases it is
 * in: `already-repaired` (this process fixed it) versus `upstream-fixed` (the
 * installed core never had the defect, so this module should be deleted).
 */
export function repairCoreLayerGraph(): RepairOutcome {
  if (repairedThisProcess) return { repaired: false, reason: "already-repaired" }

  const node = FileSystem.node
  if (node.name !== FILESYSTEM_NODE) {
    throw new UpstreamShapeError(`expected the FileSystem node to be named ${FILESYSTEM_NODE}, found ${node.name}`)
  }
  if (FileSystemSearch.node?.name !== SEARCH_NODE) {
    throw new UpstreamShapeError(
      `expected the search node to be named ${SEARCH_NODE}, found ${String(FileSystemSearch.node?.name)}`,
    )
  }

  // `dependencies` is `readonly` to TypeScript and a plain mutable array at
  // runtime. Narrow the mutation to exactly the hole the bundler left.
  const dependencies = node.dependencies as unknown as (typeof FileSystemSearch.node | undefined)[]
  const holes = dependencies.flatMap((dependency, index) => (dependency === undefined ? [index] : []))
  if (holes.length === 0) return { repaired: false, reason: "upstream-fixed" }
  if (holes.length > 1) {
    throw new UpstreamShapeError(`expected exactly one undefined dependency, found ${holes.length} at ${holes.join()}`)
  }

  const index = holes[0]!
  dependencies[index] = FileSystemSearch.node
  if (node.dependencies[index] !== FileSystemSearch.node) {
    throw new UpstreamShapeError("the dependency array refused the write; it is frozen or a copy")
  }
  repairedThisProcess = true
  return { repaired: true, node: FILESYSTEM_NODE, dependency: SEARCH_NODE, index }
}
