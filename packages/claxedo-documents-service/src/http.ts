export const documentsServiceHttp = {
  fetch(_request: Request) {
    return Promise.resolve(new Response("Not Found", { status: 404 }))
  },
}
