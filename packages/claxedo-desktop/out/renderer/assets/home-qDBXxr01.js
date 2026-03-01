import { c as createMemo, i as insert, a as createComponent, C as ClaxedoLogo, M as Match, S as Switch, F as For, m as memo, t as template } from "./styles-BYu1h1zk.js";
import { u as useGlobalSync, a as useLayout, b as usePlatform, c as useDialog, d as useNavigate, e as useServer, f as useLanguage, g as getExtensions, S as StatusPopover, B as Button, D as DateTime, I as Icon, h as base64Encode, i as DialogSelectDirectory } from "./main-CfU7H2cy.js";
import "./mermaid-classDiagram-DWBVSOg0.js";
var _tmpl$ = /* @__PURE__ */ template(`<div class="mt-4 mx-auto flex items-center justify-center">`), _tmpl$2 = /* @__PURE__ */ template(`<div class="mt-20 w-full flex flex-col gap-4"><div class="flex gap-2 items-center justify-between pl-3"><div class="text-14-medium text-text-strong"></div></div><ul class="flex flex-col gap-2">`), _tmpl$3 = /* @__PURE__ */ template(`<div class="mt-30 mx-auto flex flex-col items-center gap-3"><div class="flex flex-col gap-1 items-center justify-center"><div class="text-14-medium text-text-strong"></div><div class="text-12-regular text-text-weak"></div></div><div>`), _tmpl$4 = /* @__PURE__ */ template(`<div class="mx-auto mt-55 w-full md:w-auto px-4">`), _tmpl$5 = /* @__PURE__ */ template(`<div class="text-14-regular text-text-weak">`);
function Home() {
  const sync = useGlobalSync();
  const layout = useLayout();
  const platform = usePlatform();
  const dialog = useDialog();
  const navigate = useNavigate();
  const server = useServer();
  const language = useLanguage();
  const homedir = createMemo(() => sync.data.path.home);
  const recent = createMemo(() => {
    return sync.data.project.toSorted((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)).slice(0, 5);
  });
  async function openProject(directory) {
    if (server.isLocal()) {
      await sync.project.ensure(directory);
    }
    layout.projects.open(directory);
    server.projects.touch(directory);
    navigate(`/${base64Encode(directory)}`);
  }
  async function chooseProject() {
    const ext2 = getExtensions();
    async function resolve(result) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          await openProject(directory);
        }
      } else if (result) {
        await openProject(result);
      }
    }
    if (platform.platform === "web" && ext2.app.webProjectDialog) {
      const WebProjectDialog = ext2.app.webProjectDialog;
      dialog.show(() => createComponent(WebProjectDialog, {
        onSelect: resolve
      }), () => void resolve(null));
      return;
    }
    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true
      });
      resolve(result);
    } else {
      dialog.show(() => createComponent(DialogSelectDirectory, {
        multiple: true,
        onSelect: resolve
      }), () => void resolve(null));
    }
  }
  const ext = getExtensions();
  const serverSelectorMode = () => ext.app.serverSelectorMode ?? "full";
  return (() => {
    var _el$ = _tmpl$4();
    insert(_el$, createComponent(ClaxedoLogo, {
      "class": "md:w-xl opacity-12"
    }), null);
    insert(_el$, createComponent(Switch, {
      get children() {
        return [createComponent(Match, {
          get when() {
            return serverSelectorMode() === "status-only";
          },
          get children() {
            var _el$2 = _tmpl$();
            insert(_el$2, createComponent(StatusPopover, {
              triggerClass: "flex items-center gap-2 px-3 py-1.5 rounded-md text-14-regular text-text-weak hover:bg-surface-raised-base-hover transition-colors"
            }));
            return _el$2;
          }
        }), createComponent(Match, {
          get when() {
            return serverSelectorMode() === "full";
          },
          get children() {
            var _el$3 = _tmpl$();
            insert(_el$3, createComponent(StatusPopover, {
              triggerClass: "flex items-center gap-2 px-3 py-1.5 rounded-md text-14-regular text-text-weak hover:bg-surface-raised-base-hover transition-colors"
            }));
            return _el$3;
          }
        })];
      }
    }), null);
    insert(_el$, createComponent(Switch, {
      get children() {
        return [createComponent(Match, {
          get when() {
            return sync.data.project.length > 0;
          },
          get children() {
            var _el$4 = _tmpl$2(), _el$5 = _el$4.firstChild, _el$6 = _el$5.firstChild, _el$7 = _el$5.nextSibling;
            insert(_el$6, () => language.t("home.recentProjects"));
            insert(_el$5, createComponent(Button, {
              icon: "folder-add-left",
              size: "normal",
              "class": "pl-2 pr-3",
              onClick: chooseProject,
              get children() {
                return language.t("command.project.open");
              }
            }), null);
            insert(_el$7, createComponent(For, {
              get each() {
                return recent();
              },
              children: (project) => createComponent(Button, {
                size: "large",
                variant: "ghost",
                "class": "text-14-mono text-left justify-between px-3",
                onClick: () => openProject(project.worktree),
                get children() {
                  return [memo(() => project.worktree.replace(homedir(), "~")), (() => {
                    var _el$11 = _tmpl$5();
                    insert(_el$11, () => DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative());
                    return _el$11;
                  })()];
                }
              })
            }));
            return _el$4;
          }
        }), createComponent(Match, {
          when: true,
          get children() {
            var _el$8 = _tmpl$3(), _el$9 = _el$8.firstChild, _el$0 = _el$9.firstChild, _el$1 = _el$0.nextSibling;
            _el$9.nextSibling;
            insert(_el$8, createComponent(Icon, {
              name: "folder-add-left",
              size: "large"
            }), _el$9);
            insert(_el$0, () => language.t("home.empty.title"));
            insert(_el$1, () => language.t("home.empty.description"));
            insert(_el$8, createComponent(Button, {
              "class": "px-3",
              onClick: chooseProject,
              get children() {
                return language.t("command.project.open");
              }
            }), null);
            return _el$8;
          }
        })];
      }
    }), null);
    return _el$;
  })();
}
export {
  Home as default
};
