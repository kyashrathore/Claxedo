# ACP transport

`streams.ts` adapts the agent process's Node streams to the web streams `ndJsonStream` takes, with the global `ReadableStream` and `WritableStream` constructors. `Readable.toWeb` returns `node:stream/web` types, and a package that compiles this source with the DOM library (as `workspace-runtime` does) sees the SDK's parameters as the DOM's types, which that return type doesn't satisfy. The reader pulls one chunk per request, so a slow consumer applies backpressure to the agent's output.
