import path from "node:path"
import type { AgentCliEnv } from "../../../harness/e2e/harness/isolated-env"
import { PINNED_PI } from "../../../harness/e2e/harness/pinned-pi"

const STAND_INS = path.join(import.meta.dirname, "stand-ins")

export const APP_AGENT_ENV: AgentCliEnv = { path: [STAND_INS], env: { PI_EXECUTABLE: PINNED_PI } }
