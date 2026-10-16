import fs from "node:fs"
import { setOperatorLogSink } from "@claxedo/helpers/operator-log"
import { WORKSPACE_RUNTIME_OPERATOR_LOG } from "./boot-contract"

/**
 * Opens the operator log the sandbox named and takes its path out of `env`, so
 * no process the runtime starts afterwards inherits it. Node opens the file
 * close-on-exec, so a child gets neither the path nor the descriptor.
 */
export function claimOperatorLog(env: NodeJS.ProcessEnv) {
  const file = env[WORKSPACE_RUNTIME_OPERATOR_LOG]
  delete env[WORKSPACE_RUNTIME_OPERATOR_LOG]
  if (!file) return
  const descriptor = fs.openSync(file, "a", 0o600)
  setOperatorLogSink((line) => fs.writeSync(descriptor, line))
}
