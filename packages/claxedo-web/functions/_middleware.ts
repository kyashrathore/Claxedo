import { publicOrigin } from "../src/content/routes"

type EventContext = { request: Request; next: () => Promise<Response> }

const canonical = new URL(publicOrigin)

export const onRequest = async ({ request, next }: EventContext): Promise<Response> => {
  const url = new URL(request.url)
  if (url.hostname !== `www.${canonical.hostname}`) return next()
  url.hostname = canonical.hostname
  url.protocol = canonical.protocol
  url.port = ""
  return Response.redirect(url.toString(), 301)
}
