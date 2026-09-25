export const H1_DROP_ACP_TOOL_OUTPUT = "H1_DROP_ACP_TOOL_OUTPUT"

export function deliveredToolOutput(output: unknown) {
  return process.env[H1_DROP_ACP_TOOL_OUTPUT] === "1" ? null : output
}
