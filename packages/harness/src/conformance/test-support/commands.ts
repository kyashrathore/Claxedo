import { expect } from "bun:test"
import type { HarnessSession, HarnessTransport, RoutedEvent, TurnBroker, TurnInput } from "../../contract"

type CommandCase = {
  transport: HarnessTransport
  session: HarnessSession
  turn(prompt: string): TurnInput
  turnBroker(): TurnBroker
  args(name: string): string
  whileRunning?(name: string): Promise<void>
  observe(name: string, events: readonly RoutedEvent[]): void
}

export async function assertListedCommandsRun(input: CommandCase): Promise<void> {
  const listing = input.transport.commands
  expect(listing).toBeDefined()
  if (!listing) return
  let commands = await listing.list({ session: input.session })
  for (let attempt = 0; commands.length === 0 && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    commands = await listing.list({ session: input.session })
  }
  expect(commands.length).toBeGreaterThan(0)
  for (const command of commands) {
    const prompt = `/${command.name}${input.args(command.name) ? ` ${input.args(command.name)}` : ""}`
    const running = (async () => {
      const events: RoutedEvent[] = []
      for await (const event of input.transport.send(input.session, input.turn(prompt), input.turnBroker())) events.push(event)
      return events
    })()
    await input.whileRunning?.(command.name)
    input.observe(command.name, await running)
  }
}
