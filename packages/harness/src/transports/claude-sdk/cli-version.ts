import type { HarnessVersionRange } from "../../contract"

export const CLAUDE_CODE_RANGE = { transport: "claude", program: "Claude Code", min: "2.1.280", max: "2.1.285" } as const satisfies HarnessVersionRange
