// Low-level send boundaries: the actual prompt/shell/slash-command calls into
// the chosen client. Higher-level orchestration (busy state, worktree waits,
// rollback) lives in send.ts.
import type { PromptDispatchInput, ShellDispatchInput, SlashCommandDispatchInput } from "./types"

export async function dispatchPrompt(input: PromptDispatchInput) {
  if (input.demo) {
    const response = await input.client.session.prompt(input.payload)
    if (response.error) throw response.error
    const reply = response.data
    if (reply?.info && reply.parts) input.onDemoReply(reply)
    return
  }
  await input.client.session.promptAsync(input.payload)
}

export async function dispatchShellCommand(input: ShellDispatchInput) {
  await input.client.session.shell(input.payload)
}

export async function dispatchSlashCommand(input: SlashCommandDispatchInput) {
  await input.client.session.command(input.payload)
}
