import { catchError, type Accessor } from "solid-js"
import type { PageProps, SurfaceActionEvent, SurfaceMessage, SurfacePageDefinition, SurfaceProgram } from "@claxedo/plugin-api"
import type { Surface } from "@/surface"
import { surfacePageMachine, type SurfacePageState } from "./model"

export class SurfaceProgramError extends Error {
  constructor(readonly surfaceId: string, cause: unknown) {
    super(typeof cause === "string" ? cause : "This page's plugin failed", { cause })
    this.name = "SurfaceProgramError"
  }
}

export type SurfacePageInput = {
  readonly surface: Pick<Surface, "surfaceId" | "apply">
  readonly page: SurfacePageDefinition
  readonly props: PageProps
}

export type SurfacePageController = {
  readonly state: Accessor<SurfacePageState>
  readonly action: (action: SurfaceActionEvent) => void
  readonly close: () => void
}

function asError(surfaceId: string, error: unknown): Error {
  return error instanceof Error ? error : new SurfaceProgramError(surfaceId, error)
}

type PageMachine = ReturnType<typeof surfacePageMachine>

function messageReceiver(surface: SurfacePageInput["surface"], machine: PageMachine, fail: (error: unknown) => void) {
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

function runSurfaceAction(program: SurfaceProgram, action: SurfaceActionEvent, fail: (error: unknown) => void): void {
  try {
    Promise.resolve(program.action?.(action)).catch(fail)
  } catch (error) {
    fail(error)
  }
}

export function openSurfacePage(input: SurfacePageInput): SurfacePageController {
  const { surfaceId } = input.surface
  const machine = surfacePageMachine()
  const fail = (error: unknown) => machine.send({ type: "failed", error: asError(surfaceId, error) })
  const receive = messageReceiver(input.surface, machine, fail)
  let program: SurfaceProgram = {}
  catchError(() => {
    program = input.page.surface({ surfaceId, send: (...messages) => receive(messages) }, input.props) ?? {}
  }, fail)
  return {
    state: machine.state,
    action: (action) => {
      if (machine.state().kind === "open") runSurfaceAction(program, action, fail)
    },
    close: () => {
      if (machine.state().kind === "closed") return
      machine.send({ type: "closed" })
      try {
        program.dispose?.()
      } catch (error) {
        console.error(`Plugin page ${input.page.id} failed to close surface ${surfaceId}`, error)
      }
    },
  }
}
