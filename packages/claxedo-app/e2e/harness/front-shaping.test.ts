import assert from "node:assert/strict"
import { describe, test } from "node:test"
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
    assert.deepEqual(answer("/index.html"), { cacheControl: "no-transform, public, max-age=0, must-revalidate", compress: false })
    assert.deepEqual(answer("/assets/main-abc.js"), { cacheControl: "no-transform, public, max-age=31536000, immutable", compress: false })
  })

  test("assets compress once their block drops no-transform while the shell keeps it", () => {
    const answer = pagesHeaders(distWith(`/*
  Cache-Control: no-transform, public, max-age=0, must-revalidate
/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
`))
    assert.deepEqual(answer("/assets/main-abc.js"), { cacheControl: "public, max-age=31536000, immutable", compress: true })
    assert.equal(answer("/w/x/session/y").compress, false)
  })

  test("a repeated header without a detach joins, and no file means the publisher's default", () => {
    const joined = pagesHeaders(distWith(`/*
  Cache-Control: public
/*.css
  Cache-Control: max-age=60
`))
    assert.equal(joined("/main.css").cacheControl, "public, max-age=60")
    assert.deepEqual(pagesHeaders(distWith(undefined))("/anything"), { cacheControl: "public, max-age=0, must-revalidate", compress: true })
  })
})
