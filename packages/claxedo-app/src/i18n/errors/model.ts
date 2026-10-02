import type { ErrorClass } from "@/server"

export type ErrorMessages = Readonly<Record<ErrorClass, readonly [title: string, message: string]>> & {
  readonly signIn: string
  readonly retry: string
  readonly reload: string
}
