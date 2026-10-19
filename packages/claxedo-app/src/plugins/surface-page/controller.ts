import { catchError, type Accessor } from "solid-js"
import type { PageProps, SurfaceActionEvent, SurfaceChannel, SurfaceMessage, SurfaceProgram } from "@claxedo/plugin-api"
import type { Surface } from "@/surface"
import { surfacePageMachine, type SurfacePageState } from "./model"

export class SurfaceProgramError extends Error {
  constructor(readonly surfaceId: string, cause: unknown) {
    super(typeof cause === "string" ? cause : "This page's plugin failed", { cause })
    this.name = "SurfaceProgramError"
  }
}

export type PluginSurfaceInput = {
  readonly surface: Pick<Surface, "surfaceId" | "apply">
  readonly label: string
  readonly open: (channel: SurfaceChannel) => SurfaceProgram | void
}

export type SurfacePageController = {
  readonly state: Accessor<SurfacePageState>
  readonly action: (action: SurfaceActionEvent) => void
  readonly navigated: (props: PageProps) => void
  readonly close: () => void
}

function asError(surfaceId: string, error: unknown): Error {
  return error instanceof Error ? error : new SurfaceProgramError(surfaceId, error)
}

type PageMachine = ReturnType<typeof surfacePageMachine>

function messageReceiver(surface: PluginSurfaceInput["surface"], machine: PageMachine, fail: (error: unknown) => void) {
  return (messages: readonly SurfaceMessage[]) => {
    for (const message of messages) {
      if (machine.state().kind !== "open") return
      try {
        surface.apply(message)
      } catch (error) {
        fail(error)
      }
    }
  }
}

function runProgram(work: () => void | Promise<void>, fail: (error: unknown) => void): void {
  try {
    Promise.resolve(work()).catch(fail)
  } catch (error) {
    fail(error)
  }
}

export function openPluginSurface(input: PluginSurfaceInput): SurfacePageController {
  const { surfaceId } = input.surface
  const machine = surfacePageMachine()
  const fail = (error: unknown) => machine.send({ type: "failed", error: asError(surfaceId, error) })
  const receive = messageReceiver(input.surface, machine, fail)
  let program: SurfaceProgram = {}
  catchError(() => {
    program = input.open({ surfaceId, send: (...messages) => receive(messages) }) ?? {}
  }, fail)
  const whileOpen = (work: () => void | Promise<void>) => {
    if (machine.state().kind === "open") runProgram(work, fail)
  }
  return {
    state: machine.state,
    action: (action) => whileOpen(() => program.action?.(action)),
    navigated: (props) => whileOpen(() => program.navigated?.(props)),
    close: () => {
      if (machine.state().kind === "closed") return
      machine.send({ type: "closed" })
      try {
        program.dispose?.()
      } catch (error) {
        console.error(`Plugin ${input.label} failed to close surface ${surfaceId}`, error)
      }
    },
  }
}
