import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pagesHeaders } from "./front-shaping"

function distWith(headers: string | undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "front-shaping-"))
  if (headers !== undefined) fs.writeFileSync(path.join(dir, "_headers"), headers)
  return dir
}

describe("pagesHeaders", () => {
  test("a no-transform shell and detached immutable assets, as the app's _headers before compression was allowed", () => {
    const answer = pagesHeaders(distWith(`# comment
/*
  Cache-Control: no-transform, public, max-age=0, must-revalidate
  X-Frame-Options: SAMEORIGIN

/assets/*
  ! Cache-Control
  Cache-Control: no-transform, public, max-age=31536000, immutable

/assets/*.js
  Content-Type: application/javascript
`))
    expect(answer("/index.html")).toEqual({ cacheControl: "no-transform, public, max-age=0, must-revalidate", compress: false })
    expect(answer("/assets/main-abc.js")).toEqual({ cacheControl: "no-transform, public, max-age=31536000, immutable", compress: false })
  })

  test("assets compress once their block drops no-transform while the shell keeps it", () => {
    const answer = pagesHeaders(distWith(`/*
  Cache-Control: no-transform, public, max-age=0, must-revalidate
/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
`))
    expect(answer("/assets/main-abc.js")).toEqual({ cacheControl: "public, max-age=31536000, immutable", compress: true })
    expect(answer("/w/x/session/y").compress).toBe(false)
  })

  test("a repeated header without a detach joins, and no file means the publisher's default", () => {
    const joined = pagesHeaders(distWith(`/*
  Cache-Control: public
/*.css
  Cache-Control: max-age=60
`))
    expect(joined("/main.css").cacheControl).toBe("public, max-age=60")
    expect(pagesHeaders(distWith(undefined))("/anything")).toEqual({ cacheControl: "public, max-age=0, must-revalidate", compress: true })
  })
})
