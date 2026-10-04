import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { readMachineSkills } from "./skills"

const roots: string[] = []
async function temporaryHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-discovery-skills-"))
  roots.push(root)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function writeSkill(root: string, name: string) {
  const skillRoot = path.join(root, name)
  await fs.mkdir(skillRoot, { recursive: true })
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`)
  return skillRoot
}

describe("readMachineSkills", () => {
  test("reads every harness's machine-wide skills directory", async () => {
    const home = await temporaryHome()
    const claude = await writeSkill(path.join(home, ".claude", "skills"), "pdf")
    const opencode = await writeSkill(path.join(home, ".config", "opencode", "skills"), "review")
    const codex = await writeSkill(path.join(home, ".codex", "skills"), "docx")
    const cursor = await writeSkill(path.join(home, ".cursor", "skills"), "xlsx")
    const agents = await writeSkill(path.join(home, ".agents", "skills"), "tdd")

    await expect(readMachineSkills({ home })).resolves.toEqual([
      { name: "pdf", harnessId: "claude", root: claude },
      { name: "review", harnessId: "opencode", root: opencode },
      { name: "docx", harnessId: "codex", root: codex },
      { name: "xlsx", harnessId: "cursor", root: cursor },
      { name: "tdd", harnessId: "agents", root: agents },
    ])
  })

  test("reads Codex's skills from CODEX_HOME when the caller names one", async () => {
    const home = await temporaryHome()
    const codexHome = await temporaryHome()
    await writeSkill(path.join(home, ".codex", "skills"), "ignored")
    const skillRoot = await writeSkill(path.join(codexHome, "skills"), "docx")

    await expect(readMachineSkills({ home, codexHome })).resolves
      .toEqual([{ name: "docx", harnessId: "codex", root: skillRoot }])
  })

  test("a directory without SKILL.md, a dotted directory and a stray file are not skills", async () => {
    const home = await temporaryHome()
    const root = path.join(home, ".claude", "skills")
    const real = await writeSkill(root, "pdf")
    await writeSkill(root, ".hidden")
    await fs.mkdir(path.join(root, "not-a-skill"), { recursive: true })
    await fs.writeFile(path.join(root, "README.md"), "not a skill")

    await expect(readMachineSkills({ home })).resolves.toEqual([{ name: "pdf", harnessId: "claude", root: real }])
  })

  test("orders rows by harness then name so a re-read does not reshuffle them", async () => {
    const home = await temporaryHome()
    const root = path.join(home, ".claude", "skills")
    await writeSkill(root, "zeta")
    await writeSkill(root, "alpha")
    await writeSkill(path.join(home, ".agents", "skills"), "beta")

    const names = (await readMachineSkills({ home })).map((skill) => `${skill.harnessId}/${skill.name}`)
    expect(names).toEqual(["claude/alpha", "claude/zeta", "agents/beta"])
  })

  test("tolerates a home with no skills directories at all", async () => {
    await expect(readMachineSkills({ home: await temporaryHome() })).resolves.toEqual([])
  })
})
