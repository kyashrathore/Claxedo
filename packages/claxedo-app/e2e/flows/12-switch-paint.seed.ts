import { acpScriptToken, SCRIPTED_ACP_HARNESS, type AcpStep, type ClaxedoApi, type Stack } from "../harness"

export async function seedTurns(stack: Stack, api: ClaxedoApi, directory: string, title: string, turns: number, shape: { readonly lines?: number; readonly lastFails?: boolean } = {}) {
  const session = await api.createSession(directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const reply = Array.from({ length: 6 }, (_, line) => `${title} reply line ${line + 1}.`).join("\n\n")
  const steps: AcpStep[] = [{ kind: "tool", tool: "read", title: "Read part-1.md", locations: [{ path: `${directory}/part-1.md` }], text: "part\n" }, { kind: "text", text: reply }]
  await stack.acp.write(`paint-${title}`, { steps })
  await stack.acp.write(`paint-${title}-last`, { steps: [...steps, ...(shape.lastFails ? [{ kind: "error", message: `${title} failed` } as const] : [])] })
  const body = (turn: number) => Array.from({ length: shape.lines ?? 1 }, (_, line) => `${title} turn ${turn} line ${line + 1}: review the fixture and implement the next improvement.`).join("\n")
  for (let turn = 1; turn <= turns; turn += 1) {
    const script = turn === turns ? `paint-${title}-last` : `paint-${title}`
    await api.prompt(directory, session.id, `${body(turn)} ${acpScriptToken(script)}`).catch((error: unknown) => {
      if (!shape.lastFails || turn !== turns) throw error
    })
  }
  return session
}
