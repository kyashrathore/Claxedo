# Vendored from Arctic

The files in this directory (`oauth2.ts`, `request.ts`, `google.ts`) are
vendored from the `arctic` npm package, version **2.3.4**
(https://github.com/pilcrowonpaper/arctic), MIT licensed,
Copyright (c) pilcrowOnPaper.

Adaptations made during vendoring (2026-07-03):

- Converted compiled JS + `.d.ts` to TypeScript source.
- Replaced the `@oslojs/encoding` and `@oslojs/crypto` dependencies with
  `node:crypto` / `Buffer` equivalents (base64 / base64url / sha256) so the
  vendored code has zero dependencies.
- `sendTokenRequest` / `sendTokenRevocationRequest` accept an injectable
  `fetch` implementation for tests.

Original MIT license:

MIT License

Copyright (c) pilcrowOnPaper

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
