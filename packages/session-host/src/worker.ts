export { SessionDO } from "./session-do"

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 })
  },
}
