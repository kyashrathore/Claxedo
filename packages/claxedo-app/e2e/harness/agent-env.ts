import type { AgentCliEnv } from "../../../harness/e2e/harness/isolated-env"
import { PINNED_PI } from "../../../harness/e2e/harness/pinned-pi"

export const APP_AGENT_ENV: AgentCliEnv = { path: [], env: { PI_EXECUTABLE: PINNED_PI } }
