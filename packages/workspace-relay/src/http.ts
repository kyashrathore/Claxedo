import { bearerToken } from "@claxedo/helpers/string"

export { bearerToken }

export function errorBody(code: string, message: string) {
  return {
    error: {
      code,
      message,
    },
  }
}
