import fs from "node:fs"
import path from "node:path"
import { expect, test } from "vitest"
import { checkSandboxImageInstalls, imageInstallErrors } from "../check-image-installs"

const root = path.resolve(import.meta.dirname, "..")
const installer = fs.readFileSync(path.join(root, "install-agent-artifacts.sh"), "utf8")

test("both images run the same pinned artifact installer", () => {
  expect(checkSandboxImageInstalls()).toEqual([])
})

test("a streamed or untracked download is rejected", () => {
  expect(imageInstallErrors(`${installer}\ncurl https://example.com/install | sh`)).toContain("remote installer piped to a shell")
  expect(imageInstallErrors(`${installer}\ncurl https://example.com/install | /bin/bash`)).toContain("remote installer piped to a shell")
  expect(imageInstallErrors(`${installer}\nwget https://example.com/agent`)).toContain("wget download")
  expect(imageInstallErrors(`${installer}\nADD https://example.com/agent /tmp/agent`)).toContain("remote ADD")
  expect(imageInstallErrors(`${installer}\nADD --chmod=0755 https://example.com/agent /tmp/agent`)).toContain("remote ADD")
  expect(imageInstallErrors(`${installer}\ncurl -fsSL https://example.com/agent`)).toEqual(expect.arrayContaining([expect.stringContaining("download is not written to a file")]))
  expect(imageInstallErrors(`${installer}\ncurl -fsSL "$download_url" -o /tmp/agent`)).toContain("download has no version: /tmp/agent")
})

test("the artifact must have a literal version and digest before use", () => {
  expect(imageInstallErrors(installer.replace(/cursor_version=[^\s]+/, "cursor_version=latest")))
    .toContain("download version is not literal: cursor_version")
  expect(imageInstallErrors(installer.replace(/cursor_sha256=[a-f0-9]{64}/, "cursor_sha256=missing")))
    .toContain("SHA-256 is not literal: cursor_sha256")
  expect(imageInstallErrors(installer.replace("/tmp/droid | sha256sum -c -", "/tmp/droid | cat")))
    .toContain("download lacks literal SHA-256 check: /tmp/droid")
  expect(imageInstallErrors(installer.replace("printf '%s  %s\\n' \"$droid_sha256\" /tmp/droid | sha256sum -c -", "chmod +x /tmp/droid\nprintf '%s  %s\\n' \"$droid_sha256\" /tmp/droid | sha256sum -c -")))
    .toContain("download used before SHA-256 check: /tmp/droid")
})

test("every global npm package names an exact version", () => {
  expect(imageInstallErrors("RUN npm i -g @example/tool@latest"))
    .toContain("npm i -g: unpinned package @example/tool@latest")
  expect(imageInstallErrors("ARG AGENTS=\"@example/tool@latest\"\nRUN npm i -g ${AGENTS}"))
    .toContain("npm i -g: unpinned package @example/tool@latest")
})
