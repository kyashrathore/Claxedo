/** The control plane's two Worker roles: the writer under `CLAXEDO_WORKER_NAME`, and the edge Worker a deployment that reads at the edge adds. */
export type ControlPlaneWorker = "writer" | "edge"

export type ControlPlaneStep =
  | { readonly kind: "deploy"; readonly worker: ControlPlaneWorker }
  | { readonly kind: "release-routes"; readonly from: ControlPlaneWorker }
  | { readonly kind: "delete"; readonly worker: "edge" }

/**
 * The order a control-plane deploy publishes its Workers in, from the
 * deployment's mode and whether an edge Worker is deployed now. A route
 * moves only off the Worker that holds it before the other is deployed to
 * take it, since Wrangler refuses routes "assigned to another worker" and a
 * Worker deployed without routes keeps the ones it had; between the two the
 * public origin answers those paths with the deploy-window 503.
 *
 * - Edge reads on: the writer (no routes) first, then the routes off it, then
 *   the edge, which binds the writer by name and takes the routes.
 * - Edge reads off, with an edge Worker left from an earlier deploy: the
 *   routes off the edge, then the one Worker with them, then the edge goes.
 * - Edge reads off and no edge Worker: the one Worker, as before the split.
 */
export function controlPlaneSteps(input: { edgeReads: boolean; edgeDeployed: boolean }): ControlPlaneStep[] {
  if (input.edgeReads) {
    return [{ kind: "deploy", worker: "writer" }, { kind: "release-routes", from: "writer" }, { kind: "deploy", worker: "edge" }]
  }
  if (input.edgeDeployed) {
    return [{ kind: "release-routes", from: "edge" }, { kind: "deploy", worker: "writer" }, { kind: "delete", worker: "edge" }]
  }
  return [{ kind: "deploy", worker: "writer" }]
}
