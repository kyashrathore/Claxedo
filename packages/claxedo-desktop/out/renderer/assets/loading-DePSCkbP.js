import { p as createUniqueId, q as mergeDefaultProps, r as splitProps, b as createSignal, v as createNumberFormatter, c as createMemo, a as createComponent, P as Polymorphic, w as mergeProps, m as memo, g as createEffect, h as onCleanup, x as combineStyle, y as createRegisterId, z as createGenerateId, A as clamp, n as createContext, l as useContext, _ as __export, d as Show, i as insert, t as template, B as render, D as desktopApi, o as onMount, G as Font, H as ClaxedoSplash, I as MetaProvider } from "./styles-BYu1h1zk.js";
var MeterContext = createContext();
function useMeterContext() {
  const context = useContext(MeterContext);
  if (context === void 0) {
    throw new Error("[kobalte]: `useMeterContext` must be used within a `Meter.Root` component");
  }
  return context;
}
function MeterFill(props) {
  const context = useMeterContext();
  const [local, others] = splitProps(props, ["style"]);
  return createComponent(Polymorphic, mergeProps({
    as: "div",
    get style() {
      return combineStyle({
        "--kb-meter-fill-width": context.meterFillWidth()
      }, local.style);
    }
  }, () => context.dataset(), others));
}
function MeterLabel(props) {
  const context = useMeterContext();
  const mergedProps = mergeDefaultProps({
    id: context.generateId("label")
  }, props);
  const [local, others] = splitProps(mergedProps, ["id"]);
  createEffect(() => onCleanup(context.registerLabelId(local.id)));
  return createComponent(Polymorphic, mergeProps({
    as: "span",
    get id() {
      return local.id;
    }
  }, () => context.dataset(), others));
}
function MeterRoot(props) {
  const defaultId = `meter-${createUniqueId()}`;
  const mergedProps = mergeDefaultProps({
    id: defaultId,
    value: 0,
    minValue: 0,
    maxValue: 100,
    role: "meter",
    indeterminate: false
  }, props);
  const [local, others] = splitProps(mergedProps, ["value", "minValue", "maxValue", "getValueLabel", "role", "aria-valuetext", "aria-labelledby", "aria-valuemax", "aria-valuemin", "aria-valuenow", "indeterminate"]);
  const [labelId, setLabelId] = createSignal();
  const defaultFormatter = createNumberFormatter(() => ({
    style: "percent"
  }));
  const value = () => {
    return clamp(local.value, local.minValue, local.maxValue);
  };
  const valuePercent = () => {
    return (value() - local.minValue) / (local.maxValue - local.minValue);
  };
  const valueLabel = () => {
    if (local.indeterminate) {
      return void 0;
    }
    if (local.getValueLabel) {
      return local.getValueLabel({
        value: value(),
        min: local.minValue,
        max: local.maxValue
      });
    }
    return defaultFormatter().format(valuePercent());
  };
  const meterFillWidth = () => {
    return `${valuePercent() * 100}%`;
  };
  const dataset = createMemo(() => {
    return {};
  });
  const context = {
    dataset,
    value,
    valuePercent,
    valueLabel,
    labelId,
    meterFillWidth,
    generateId: createGenerateId(() => others.id),
    registerLabelId: createRegisterId(setLabelId)
  };
  return createComponent(MeterContext.Provider, {
    value: context,
    get children() {
      return createComponent(Polymorphic, mergeProps({
        as: "div",
        get role() {
          return local.role || "meter";
        },
        get ["aria-valuenow"]() {
          return memo(() => !!local.indeterminate)() ? void 0 : value();
        },
        get ["aria-valuemin"]() {
          return local.minValue;
        },
        get ["aria-valuemax"]() {
          return local.maxValue;
        },
        get ["aria-valuetext"]() {
          return valueLabel();
        },
        get ["aria-labelledby"]() {
          return labelId();
        }
      }, dataset, others));
    }
  });
}
function MeterTrack(props) {
  const context = useMeterContext();
  return createComponent(Polymorphic, mergeProps({
    as: "div"
  }, () => context.dataset(), props));
}
function MeterValueLabel(props) {
  const context = useMeterContext();
  return createComponent(Polymorphic, mergeProps({
    as: "div"
  }, () => context.dataset(), props, {
    get children() {
      return context.valueLabel();
    }
  }));
}
var Meter = Object.assign(MeterRoot, {
  Fill: MeterFill,
  Label: MeterLabel,
  Track: MeterTrack,
  ValueLabel: MeterValueLabel
});
var progress_exports = {};
__export(progress_exports, {
  Fill: () => ProgressFill,
  Label: () => ProgressLabel,
  Progress: () => Progress$1,
  Root: () => ProgressRoot,
  Track: () => ProgressTrack,
  ValueLabel: () => ProgressValueLabel,
  useProgressContext: () => useProgressContext
});
var ProgressContext = createContext();
function useProgressContext() {
  const context = useContext(ProgressContext);
  if (context === void 0) {
    throw new Error("[kobalte]: `useProgressContext` must be used within a `Progress.Root` component");
  }
  return context;
}
function ProgressFill(props) {
  const context = useProgressContext();
  const [local, others] = splitProps(props, ["style"]);
  return createComponent(Meter.Fill, mergeProps({
    get style() {
      return combineStyle({
        "--kb-progress-fill-width": context.progressFillWidth()
      }, local.style);
    }
  }, () => context.dataset(), others));
}
function ProgressLabel(props) {
  const context = useProgressContext();
  const mergedProps = mergeDefaultProps({
    id: context.generateId("label")
  }, props);
  const [local, others] = splitProps(mergedProps, ["id"]);
  createEffect(() => onCleanup(context.registerLabelId(local.id)));
  return createComponent(Meter.Label, mergeProps({
    get id() {
      return local.id;
    }
  }, () => context.dataset(), others));
}
function ProgressRoot(props) {
  const defaultId = `progress-${createUniqueId()}`;
  const mergedProps = mergeDefaultProps({
    id: defaultId,
    value: 0,
    minValue: 0,
    maxValue: 100
  }, props);
  const [local, others] = splitProps(mergedProps, ["value", "minValue", "maxValue", "indeterminate", "getValueLabel"]);
  const [labelId, setLabelId] = createSignal();
  const defaultFormatter = createNumberFormatter(() => ({
    style: "percent"
  }));
  const value = () => {
    return clamp(local.value, local.minValue, local.maxValue);
  };
  const valuePercent = () => {
    return (value() - local.minValue) / (local.maxValue - local.minValue);
  };
  const valueLabel = () => {
    if (local.indeterminate) {
      return void 0;
    }
    if (local.getValueLabel) {
      return local.getValueLabel({
        value: value(),
        min: local.minValue,
        max: local.maxValue
      });
    }
    return defaultFormatter().format(valuePercent());
  };
  const progressFillWidth = () => {
    return local.indeterminate ? void 0 : `${valuePercent() * 100}%`;
  };
  const dataset = createMemo(() => {
    let dataProgress = void 0;
    if (!local.indeterminate) {
      dataProgress = valuePercent() === 1 ? "complete" : "loading";
    }
    return {
      "data-progress": dataProgress,
      "data-indeterminate": local.indeterminate ? "" : void 0
    };
  });
  const context = {
    dataset,
    value,
    valuePercent,
    valueLabel,
    labelId,
    progressFillWidth,
    generateId: createGenerateId(() => others.id),
    registerLabelId: createRegisterId(setLabelId)
  };
  return createComponent(ProgressContext.Provider, {
    value: context,
    get children() {
      return createComponent(Meter, mergeProps({
        role: "progressbar",
        get indeterminate() {
          return local.indeterminate || false;
        }
      }, dataset, mergedProps));
    }
  });
}
function ProgressTrack(props) {
  const context = useProgressContext();
  return createComponent(Meter.Track, mergeProps(() => context.dataset(), props));
}
function ProgressValueLabel(props) {
  const context = useProgressContext();
  return createComponent(Meter.ValueLabel, mergeProps(() => context.dataset(), props));
}
var Progress$1 = Object.assign(ProgressRoot, {
  Fill: ProgressFill,
  Label: ProgressLabel,
  Track: ProgressTrack,
  ValueLabel: ProgressValueLabel
});
var _tmpl$$1 = /* @__PURE__ */ template(`<div data-slot=progress-header>`);
function Progress(props) {
  const [local, others] = splitProps(props, ["children", "class", "classList", "hideLabel", "showValueLabel"]);
  return createComponent(Progress$1, mergeProps(others, {
    "data-component": "progress",
    get classList() {
      return {
        ...local.classList ?? {},
        [local.class ?? ""]: !!local.class
      };
    },
    get children() {
      return [createComponent(Show, {
        get when() {
          return local.children || local.showValueLabel;
        },
        get children() {
          var _el$ = _tmpl$$1();
          insert(_el$, createComponent(Show, {
            get when() {
              return local.children;
            },
            get children() {
              return createComponent(Progress$1.Label, {
                "data-slot": "progress-label",
                get classList() {
                  return {
                    "sr-only": local.hideLabel
                  };
                },
                get children() {
                  return local.children;
                }
              });
            }
          }), null);
          insert(_el$, createComponent(Show, {
            get when() {
              return local.showValueLabel;
            },
            get children() {
              return createComponent(Progress$1.ValueLabel, {
                "data-slot": "progress-value-label"
              });
            }
          }), null);
          return _el$;
        }
      }), createComponent(Progress$1.Track, {
        "data-slot": "progress-track",
        get children() {
          return createComponent(Progress$1.Fill, {
            "data-slot": "progress-fill"
          });
        }
      })];
    }
  }));
}
var _tmpl$ = /* @__PURE__ */ template(`<div class="w-screen h-screen bg-background-base flex items-center justify-center"><div class="flex flex-col items-center gap-10"><div class="w-60 flex flex-col items-center gap-4"aria-live=polite><span class="w-full overflow-hidden text-center text-ellipsis whitespace-nowrap text-text-strong text-14-normal">`);
const root = document.getElementById("root");
const lines = ["Just a moment...", "Migrating your database", "This may take a couple of minutes"];
const delays = [3e3, 9e3];
render(() => {
  let splash;
  const [step, setStep] = createSignal(null);
  const [line, setLine] = createSignal(0);
  const [percent, setPercent] = createSignal(0);
  const phase = createMemo(() => step()?.phase);
  const value = createMemo(() => {
    if (phase() === "done") return 100;
    return Math.max(25, Math.min(100, percent()));
  });
  desktopApi().awaitInitialization((next) => setStep(next)).then(() => {
    setStep({
      phase: "done"
    });
    const currentOpacity = getComputedStyle(splash).opacity;
    splash.style.animation = "none";
    splash.style.animationPlayState = "paused";
    splash.style.opacity = currentOpacity;
    requestAnimationFrame(() => {
      splash.style.transition = "opacity 0.3s ease";
      requestAnimationFrame(() => {
        splash.style.opacity = "1";
      });
    });
  }).catch(() => void 0);
  onMount(() => {
    setLine(0);
    setPercent(0);
    const timers = delays.map((ms, i) => setTimeout(() => setLine(i + 1), ms));
    const listener = desktopApi().onSqliteMigrationProgress((progress) => {
      if (progress.type === "InProgress") setPercent(Math.max(0, Math.min(100, progress.value)));
      if (progress.type === "Done") setPercent(100);
    });
    onCleanup(() => {
      listener();
      timers.forEach(clearTimeout);
    });
  });
  createEffect(() => {
    if (phase() !== "done") return;
    const timer = setTimeout(() => desktopApi().loadingWindowComplete(), 1e3);
    onCleanup(() => clearTimeout(timer));
  });
  const status = createMemo(() => {
    if (phase() === "done") return "All done";
    if (phase() === "sqlite_waiting") return lines[line()];
    return "Just a moment...";
  });
  return createComponent(MetaProvider, {
    get children() {
      var _el$ = _tmpl$(), _el$2 = _el$.firstChild, _el$3 = _el$2.firstChild, _el$4 = _el$3.firstChild;
      insert(_el$, createComponent(Font, {}), _el$2);
      insert(_el$2, createComponent(ClaxedoSplash, {
        ref(r$) {
          var _ref$ = splash;
          typeof _ref$ === "function" ? _ref$(r$) : splash = r$;
        },
        "class": "h-25 animate-[pulse-splash_2s_ease-in-out_infinite]"
      }), _el$3);
      insert(_el$4, status);
      insert(_el$3, createComponent(Progress, {
        get value() {
          return value();
        },
        "class": "w-20 [&_[data-slot='progress-track']]:h-1 [&_[data-slot='progress-track']]:border-0 [&_[data-slot='progress-track']]:rounded-none [&_[data-slot='progress-track']]:bg-surface-weak [&_[data-slot='progress-fill']]:rounded-none [&_[data-slot='progress-fill']]:bg-icon-warning-base",
        "aria-label": "Database migration progress",
        getValueLabel: ({
          value: value2
        }) => `${Math.round(value2)}%`
      }), null);
      return _el$;
    }
  });
}, root);
