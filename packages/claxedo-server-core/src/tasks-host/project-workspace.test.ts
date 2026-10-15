import { expect, test } from "vitest"
import { chooseProjectWorkspace } from "./project-workspace"
import type { Workspace } from "../workspace/store/index"

const checkout = (id: string, name: string) => ({ id, project_id: "prj_1", workspace_name: name, directory: `/w/${name}`, repo_root: "/w/repo" }) as Workspace

test("a project without one workspace to start in is refused in one line naming no ids", () => {
  expect(chooseProjectWorkspace("prj_1", [])).toEqual({ detail: "This project has no workspace a session can start in here" })
  expect(chooseProjectWorkspace("prj_1", [checkout("ws_a", "a"), checkout("ws_b", "b")]))
    .toEqual({ detail: "This project has 2 workspaces (a, b); name one on the task before starting" })
})
