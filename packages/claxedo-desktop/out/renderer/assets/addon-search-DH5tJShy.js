/**
 * Copyright (c) 2014-2024 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)
 * @license MIT
 *
 * Originally forked from (with the author's permission):
 *   Fabrice Bellard's javascript vt100 for jslinux:
 *   http://bellard.org/jslinux/
 *   Copyright (c) 2011 Fabrice Bellard
 */
var Re = class {
  constructor() {
    this.listeners = [], this.unexpectedErrorHandler = function(e) {
      setTimeout(() => {
        throw e.stack ? ae.isErrorNoTelemetry(e) ? new ae(e.message + `

` + e.stack) : new Error(e.message + `

` + e.stack) : e;
      }, 0);
    };
  }
  addListener(e) {
    return this.listeners.push(e), () => {
      this._removeListener(e);
    };
  }
  emit(e) {
    this.listeners.forEach((t) => {
      t(e);
    });
  }
  _removeListener(e) {
    this.listeners.splice(this.listeners.indexOf(e), 1);
  }
  setUnexpectedErrorHandler(e) {
    this.unexpectedErrorHandler = e;
  }
  getUnexpectedErrorHandler() {
    return this.unexpectedErrorHandler;
  }
  onUnexpectedError(e) {
    this.unexpectedErrorHandler(e), this.emit(e);
  }
  onUnexpectedExternalError(e) {
    this.unexpectedErrorHandler(e);
  }
}, pt = new Re();
function le(r4) {
  ft(r4) || pt.onUnexpectedError(r4);
}
var Ce = "Canceled";
function ft(r4) {
  return r4 instanceof ee ? true : r4 instanceof Error && r4.name === Ce && r4.message === Ce;
}
var ee = class extends Error {
  constructor() {
    super(Ce), this.name = this.message;
  }
};
var ae = class r extends Error {
  constructor(e) {
    super(e), this.name = "CodeExpectedError";
  }
  static fromError(e) {
    if (e instanceof r) return e;
    let t = new r();
    return t.message = e.message, t.stack = e.stack, t;
  }
  static isErrorNoTelemetry(e) {
    return e.name === "CodeExpectedError";
  }
};
var Qe;
((h) => {
  function r4(u) {
    return u < 0;
  }
  h.isLessThan = r4;
  function e(u) {
    return u <= 0;
  }
  h.isLessThanOrEqual = e;
  function t(u) {
    return u > 0;
  }
  h.isGreaterThan = t;
  function n(u) {
    return u === 0;
  }
  h.isNeitherLessOrGreaterThan = n, h.greaterThan = 1, h.lessThan = -1, h.neitherLessOrGreaterThan = 0;
})(Qe ||= {});
function Pe(r4, e) {
  let t = this, n = false, i;
  return function() {
    if (n) return i;
    if (n = true, e) ;
    else i = r4.apply(t, arguments);
    return i;
  };
}
var Le;
((z) => {
  function r4(m) {
    return m && typeof m == "object" && typeof m[Symbol.iterator] == "function";
  }
  z.is = r4;
  let e = Object.freeze([]);
  function t() {
    return e;
  }
  z.empty = t;
  function* n(m) {
    yield m;
  }
  z.single = n;
  function i(m) {
    return r4(m) ? m : n(m);
  }
  z.wrap = i;
  function s(m) {
    return m || e;
  }
  z.from = s;
  function* a(m) {
    for (let _ = m.length - 1; _ >= 0; _--) yield m[_];
  }
  z.reverse = a;
  function h(m) {
    return !m || m[Symbol.iterator]().next().done === true;
  }
  z.isEmpty = h;
  function u(m) {
    return m[Symbol.iterator]().next().value;
  }
  z.first = u;
  function p(m, _) {
    let y = 0;
    for (let L of m) if (_(L, y++)) return true;
    return false;
  }
  z.some = p;
  function T(m, _) {
    for (let y of m) if (_(y)) return y;
  }
  z.find = T;
  function* v(m, _) {
    for (let y of m) _(y) && (yield y);
  }
  z.filter = v;
  function* I(m, _) {
    let y = 0;
    for (let L of m) yield _(L, y++);
  }
  z.map = I;
  function* E(m, _) {
    let y = 0;
    for (let L of m) yield* _(L, y++);
  }
  z.flatMap = E;
  function* S(...m) {
    for (let _ of m) yield* _;
  }
  z.concat = S;
  function D(m, _, y) {
    let L = y;
    for (let X of m) L = _(L, X);
    return L;
  }
  z.reduce = D;
  function* x(m, _, y = m.length) {
    for (_ < 0 && (_ += m.length), y < 0 ? y += m.length : y > m.length && (y = m.length); _ < y; _++) yield m[_];
  }
  z.slice = x;
  function J(m, _ = Number.POSITIVE_INFINITY) {
    let y = [];
    if (_ === 0) return [y, m];
    let L = m[Symbol.iterator]();
    for (let X = 0; X < _; X++) {
      let Se = L.next();
      if (Se.done) return [y, z.empty()];
      y.push(Se.value);
    }
    return [y, { [Symbol.iterator]() {
      return L;
    } }];
  }
  z.consume = J;
  async function q(m) {
    let _ = [];
    for await (let y of m) _.push(y);
    return Promise.resolve(_);
  }
  z.asyncToArray = q;
})(Le ||= {});
function pe(r4) {
  return r4;
}
function te(r4, e) {
}
function Q(r4) {
  if (Le.is(r4)) {
    let e = [];
    for (let t of r4) if (t) try {
      t.dispose();
    } catch (n) {
      e.push(n);
    }
    if (e.length === 1) throw e[0];
    if (e.length > 1) throw new AggregateError(e, "Encountered errors while disposing of store");
    return Array.isArray(r4) ? [] : r4;
  } else if (r4) return r4.dispose(), r4;
}
function me(...r4) {
  let e = A(() => Q(r4));
  return e;
}
function A(r4) {
  let e = pe({ dispose: Pe(() => {
    r4();
  }) });
  return e;
}
var he = class he2 {
  constructor() {
    this._toDispose = /* @__PURE__ */ new Set();
    this._isDisposed = false;
  }
  dispose() {
    this._isDisposed || (this._isDisposed = true, this.clear());
  }
  get isDisposed() {
    return this._isDisposed;
  }
  clear() {
    if (this._toDispose.size !== 0) try {
      Q(this._toDispose);
    } finally {
      this._toDispose.clear();
    }
  }
  add(e) {
    if (!e) return e;
    if (e === this) throw new Error("Cannot register a disposable on itself!");
    return this._isDisposed ? he2.DISABLE_DISPOSED_WARNING || console.warn(new Error("Trying to add a disposable to a DisposableStore that has already been disposed of. The added object will be leaked!").stack) : this._toDispose.add(e), e;
  }
  delete(e) {
    if (e) {
      if (e === this) throw new Error("Cannot dispose a disposable on itself!");
      this._toDispose.delete(e), e.dispose();
    }
  }
  deleteAndLeak(e) {
    e && this._toDispose.has(e) && (this._toDispose.delete(e), te());
  }
};
he.DISABLE_DISPOSED_WARNING = false;
var H = he, k = class {
  constructor() {
    this._store = new H();
    te(this._store);
  }
  dispose() {
    this._store.dispose();
  }
  _register(e) {
    if (e === this) throw new Error("Cannot register a disposable on itself!");
    return this._store.add(e);
  }
};
k.None = Object.freeze({ dispose() {
} });
var F = class {
  constructor() {
    this._isDisposed = false;
  }
  get value() {
    return this._isDisposed ? void 0 : this._value;
  }
  set value(e) {
    this._isDisposed || e === this._value || (this._value?.dispose(), this._value = e);
  }
  clear() {
    this.value = void 0;
  }
  dispose() {
    this._isDisposed = true, this._value?.dispose(), this._value = void 0;
  }
  clearAndLeak() {
    let e = this._value;
    return this._value = void 0, e;
  }
};
var _t = globalThis.performance && typeof globalThis.performance.now == "function", Te = class r2 {
  static create(e) {
    return new r2(e);
  }
  constructor(e) {
    this._now = _t && e === false ? Date.now : globalThis.performance.now.bind(globalThis.performance), this._startTime = this._now(), this._stopTime = -1;
  }
  stop() {
    this._stopTime = this._now();
  }
  reset() {
    this._startTime = this._now(), this._stopTime = -1;
  }
  elapsed() {
    return this._stopTime !== -1 ? this._stopTime - this._startTime : this._now() - this._startTime;
  }
};
var ie;
((re) => {
  re.None = () => k.None;
  function t(d, o) {
    return I(d, () => {
    }, 0, void 0, true, void 0, o);
  }
  re.defer = t;
  function n(d) {
    return (o, c = null, l) => {
      let f = false, b;
      return b = d((g) => {
        if (!f) return b ? b.dispose() : f = true, o.call(c, g);
      }, null, l), f && b.dispose(), b;
    };
  }
  re.once = n;
  function i(d, o, c) {
    return T((l, f = null, b) => d((g) => l.call(f, o(g)), null, b), c);
  }
  re.map = i;
  function s(d, o, c) {
    return T((l, f = null, b) => d((g) => {
      o(g), l.call(f, g);
    }, null, b), c);
  }
  re.forEach = s;
  function a(d, o, c) {
    return T((l, f = null, b) => d((g) => o(g) && l.call(f, g), null, b), c);
  }
  re.filter = a;
  function h(d) {
    return d;
  }
  re.signal = h;
  function u(...d) {
    return (o, c = null, l) => {
      let f = me(...d.map((b) => b((g) => o.call(c, g))));
      return v(f, l);
    };
  }
  re.any = u;
  function p(d, o, c, l) {
    let f = c;
    return i(d, (b) => (f = o(f, b), f), l);
  }
  re.reduce = p;
  function T(d, o) {
    let c, l = { onWillAddFirstListener() {
      c = d(f.fire, f);
    }, onDidRemoveLastListener() {
      c?.dispose();
    } };
    let f = new C(l);
    return o?.add(f), f.event;
  }
  function v(d, o) {
    return o instanceof Array ? o.push(d) : o && o.add(d), d;
  }
  function I(d, o, c = 100, l = false, f = false, b, g) {
    let w, R, U, se = 0, Z, Ve = { leakWarningThreshold: b, onWillAddFirstListener() {
      w = d((dt) => {
        se++, R = o(R, dt), l && !U && (oe.fire(R), R = void 0), Z = () => {
          let ht = R;
          R = void 0, U = void 0, (!l || se > 1) && oe.fire(ht), se = 0;
        }, typeof c == "number" ? (clearTimeout(U), U = setTimeout(Z, c)) : U === void 0 && (U = 0, queueMicrotask(Z));
      });
    }, onWillRemoveListener() {
      f && se > 0 && Z?.();
    }, onDidRemoveLastListener() {
      Z = void 0, w.dispose();
    } };
    let oe = new C(Ve);
    return g?.add(oe), oe.event;
  }
  re.debounce = I;
  function E(d, o = 0, c) {
    return re.debounce(d, (l, f) => l ? (l.push(f), l) : [f], o, void 0, true, void 0, c);
  }
  re.accumulate = E;
  function S(d, o = (l, f) => l === f, c) {
    let l = true, f;
    return a(d, (b) => {
      let g = l || !o(b, f);
      return l = false, f = b, g;
    }, c);
  }
  re.latch = S;
  function D(d, o, c) {
    return [re.filter(d, o, c), re.filter(d, (l) => !o(l), c)];
  }
  re.split = D;
  function x(d, o = false, c = [], l) {
    let f = c.slice(), b = d((R) => {
      f ? f.push(R) : w.fire(R);
    });
    l && l.add(b);
    let g = () => {
      f?.forEach((R) => w.fire(R)), f = null;
    }, w = new C({ onWillAddFirstListener() {
      b || (b = d((R) => w.fire(R)), l && l.add(b));
    }, onDidAddFirstListener() {
      f && (o ? setTimeout(g) : g());
    }, onDidRemoveLastListener() {
      b && b.dispose(), b = null;
    } });
    return l && l.add(w), w.event;
  }
  re.buffer = x;
  function J(d, o) {
    return (l, f, b) => {
      let g = o(new z());
      return d(function(w) {
        let R = g.evaluate(w);
        R !== q && l.call(f, R);
      }, void 0, b);
    };
  }
  re.chain = J;
  let q = Symbol("HaltChainable");
  class z {
    constructor() {
      this.steps = [];
    }
    map(o) {
      return this.steps.push(o), this;
    }
    forEach(o) {
      return this.steps.push((c) => (o(c), c)), this;
    }
    filter(o) {
      return this.steps.push((c) => o(c) ? c : q), this;
    }
    reduce(o, c) {
      let l = c;
      return this.steps.push((f) => (l = o(l, f), l)), this;
    }
    latch(o = (c, l) => c === l) {
      let c = true, l;
      return this.steps.push((f) => {
        let b = c || !o(f, l);
        return c = false, l = f, b ? f : q;
      }), this;
    }
    evaluate(o) {
      for (let c of this.steps) if (o = c(o), o === q) break;
      return o;
    }
  }
  function m(d, o, c = (l) => l) {
    let l = (...w) => g.fire(c(...w)), f = () => d.on(o, l), b = () => d.removeListener(o, l), g = new C({ onWillAddFirstListener: f, onDidRemoveLastListener: b });
    return g.event;
  }
  re.fromNodeEventEmitter = m;
  function _(d, o, c = (l) => l) {
    let l = (...w) => g.fire(c(...w)), f = () => d.addEventListener(o, l), b = () => d.removeEventListener(o, l), g = new C({ onWillAddFirstListener: f, onDidRemoveLastListener: b });
    return g.event;
  }
  re.fromDOMEventEmitter = _;
  function y(d) {
    return new Promise((o) => n(d)(o));
  }
  re.toPromise = y;
  function L(d) {
    let o = new C();
    return d.then((c) => {
      o.fire(c);
    }, () => {
      o.fire(void 0);
    }).finally(() => {
      o.dispose();
    }), o.event;
  }
  re.fromPromise = L;
  function X(d, o) {
    return d((c) => o.fire(c));
  }
  re.forward = X;
  function Se(d, o, c) {
    return o(c), d((l) => o(l));
  }
  re.runAndSubscribe = Se;
  class ct {
    constructor(o, c) {
      this._observable = o;
      this._counter = 0;
      this._hasChanged = false;
      let l = { onWillAddFirstListener: () => {
        o.addObserver(this);
      }, onDidRemoveLastListener: () => {
        o.removeObserver(this);
      } };
      this.emitter = new C(l), c && c.add(this.emitter);
    }
    beginUpdate(o) {
      this._counter++;
    }
    handlePossibleChange(o) {
    }
    handleChange(o, c) {
      this._hasChanged = true;
    }
    endUpdate(o) {
      this._counter--, this._counter === 0 && (this._observable.reportChanges(), this._hasChanged && (this._hasChanged = false, this.emitter.fire(this._observable.get())));
    }
  }
  function zt(d, o) {
    return new ct(d, o).emitter.event;
  }
  re.fromObservable = zt;
  function Ut(d) {
    return (o, c, l) => {
      let f = 0, b = false, g = { beginUpdate() {
        f++;
      }, endUpdate() {
        f--, f === 0 && (d.reportChanges(), b && (b = false, o.call(c)));
      }, handlePossibleChange() {
      }, handleChange() {
        b = true;
      } };
      d.addObserver(g), d.reportChanges();
      let w = { dispose() {
        d.removeObserver(g);
      } };
      return l instanceof H ? l.add(w) : Array.isArray(l) && l.push(w), w;
    };
  }
  re.fromObservableLight = Ut;
})(ie ||= {});
var B = class B2 {
  constructor(e) {
    this.listenerCount = 0;
    this.invocationCount = 0;
    this.elapsedOverall = 0;
    this.durations = [];
    this.name = `${e}_${B2._idPool++}`, B2.all.add(this);
  }
  start(e) {
    this._stopWatch = new Te(), this.listenerCount = e;
  }
  stop() {
    if (this._stopWatch) {
      let e = this._stopWatch.elapsed();
      this.durations.push(e), this.elapsedOverall += e, this.invocationCount += 1, this._stopWatch = void 0;
    }
  }
};
B.all = /* @__PURE__ */ new Set(), B._idPool = 0;
var Oe = B, nt = -1;
var be = class be2 {
  constructor(e, t, n = (be2._idPool++).toString(16).padStart(3, "0")) {
    this._errorHandler = e;
    this.threshold = t;
    this.name = n;
    this._warnCountdown = 0;
  }
  dispose() {
    this._stacks?.clear();
  }
  check(e, t) {
    let n = this.threshold;
    if (n <= 0 || t < n) return;
    this._stacks || (this._stacks = /* @__PURE__ */ new Map());
    let i = this._stacks.get(e.value) || 0;
    if (this._stacks.set(e.value, i + 1), this._warnCountdown -= 1, this._warnCountdown <= 0) {
      this._warnCountdown = n * 0.5;
      let [s, a] = this.getMostFrequentStack(), h = `[${this.name}] potential listener LEAK detected, having ${t} listeners already. MOST frequent listener (${a}):`;
      console.warn(h), console.warn(s);
      let u = new Me(h, s);
      this._errorHandler(u);
    }
    return () => {
      let s = this._stacks.get(e.value) || 0;
      this._stacks.set(e.value, s - 1);
    };
  }
  getMostFrequentStack() {
    if (!this._stacks) return;
    let e, t = 0;
    for (let [n, i] of this._stacks) (!e || t < i) && (e = [n, i], t = i);
    return e;
  }
};
be._idPool = 1;
var Ae = be, ne = class r3 {
  constructor(e) {
    this.value = e;
  }
  static create() {
    let e = new Error();
    return new r3(e.stack ?? "");
  }
  print() {
    console.warn(this.value.split(`
`).slice(2).join(`
`));
  }
}, Me = class extends Error {
  constructor(e, t) {
    super(e), this.name = "ListenerLeakError", this.stack = t;
  }
}, Fe = class extends Error {
  constructor(e, t) {
    super(e), this.name = "ListenerRefusalError", this.stack = t;
  }
}, xt = 0, G = class {
  constructor(e) {
    this.value = e;
    this.id = xt++;
  }
}, It = 2, ve;
var C = class {
  constructor(e) {
    this._size = 0;
    this._options = e, this._leakageMon = this._options?.leakWarningThreshold ? new Ae(e?.onListenerError ?? le, this._options?.leakWarningThreshold ?? nt) : void 0, this._perfMon = this._options?._profName ? new Oe(this._options._profName) : void 0, this._deliveryQueue = this._options?.deliveryQueue;
  }
  dispose() {
    if (!this._disposed) {
      if (this._disposed = true, this._deliveryQueue?.current === this && this._deliveryQueue.reset(), this._listeners) {
        this._listeners = void 0, this._size = 0;
      }
      this._options?.onDidRemoveLastListener?.(), this._leakageMon?.dispose();
    }
  }
  get event() {
    return this._event ??= (e, t, n) => {
      if (this._leakageMon && this._size > this._leakageMon.threshold ** 2) {
        let u = `[${this._leakageMon.name}] REFUSES to accept new listeners because it exceeded its threshold by far (${this._size} vs ${this._leakageMon.threshold})`;
        console.warn(u);
        let p = this._leakageMon.getMostFrequentStack() ?? ["UNKNOWN stack", -1], T = new Fe(`${u}. HINT: Stack shows most frequent listener (${p[1]}-times)`, p[0]);
        return (this._options?.onListenerError || le)(T), k.None;
      }
      if (this._disposed) return k.None;
      t && (e = e.bind(t));
      let i = new G(e), s;
      this._leakageMon && this._size >= Math.ceil(this._leakageMon.threshold * 0.2) && (i.stack = ne.create(), s = this._leakageMon.check(i.stack, this._size + 1)), this._listeners ? this._listeners instanceof G ? (this._deliveryQueue ??= new Ne(), this._listeners = [this._listeners, i]) : this._listeners.push(i) : (this._options?.onWillAddFirstListener?.(this), this._listeners = i, this._options?.onDidAddFirstListener?.(this)), this._size++;
      let h = A(() => {
        s?.(), this._removeListener(i);
      });
      if (n instanceof H ? n.add(h) : Array.isArray(n) && n.push(h), ve) ;
      return h;
    }, this._event;
  }
  _removeListener(e) {
    if (this._options?.onWillRemoveListener?.(this), !this._listeners) return;
    if (this._size === 1) {
      this._listeners = void 0, this._options?.onDidRemoveLastListener?.(this), this._size = 0;
      return;
    }
    let t = this._listeners, n = t.indexOf(e);
    if (n === -1) throw console.log("disposed?", this._disposed), console.log("size?", this._size), console.log("arr?", JSON.stringify(this._listeners)), new Error("Attempted to dispose unknown listener");
    this._size--, t[n] = void 0;
    let i = this._deliveryQueue.current === this;
    if (this._size * It <= t.length) {
      let s = 0;
      for (let a = 0; a < t.length; a++) t[a] ? t[s++] = t[a] : i && (this._deliveryQueue.end--, s < this._deliveryQueue.i && this._deliveryQueue.i--);
      t.length = s;
    }
  }
  _deliver(e, t) {
    if (!e) return;
    let n = this._options?.onListenerError || le;
    if (!n) {
      e.value(t);
      return;
    }
    try {
      e.value(t);
    } catch (i) {
      n(i);
    }
  }
  _deliverQueue(e) {
    let t = e.current._listeners;
    for (; e.i < e.end; ) this._deliver(t[e.i++], e.value);
    e.reset();
  }
  fire(e) {
    if (this._deliveryQueue?.current && (this._deliverQueue(this._deliveryQueue), this._perfMon?.stop()), this._perfMon?.start(this._size), this._listeners) if (this._listeners instanceof G) this._deliver(this._listeners, e);
    else {
      let t = this._deliveryQueue;
      t.enqueue(this, e, this._listeners.length), this._deliverQueue(t);
    }
    this._perfMon?.stop();
  }
  hasListeners() {
    return this._size > 0;
  }
};
var Ne = class {
  constructor() {
    this.i = -1;
    this.end = 0;
  }
  enqueue(e, t, n) {
    this.i = 0, this.end = n, this.current = e, this.value = t;
  }
  reset() {
    this.i = this.end, this.current = void 0, this.value = void 0;
  }
};
var it = Object.freeze(function(r4, e) {
  let t = setTimeout(r4.bind(e), 0);
  return { dispose() {
    clearTimeout(t);
  } };
}), Et;
((n) => {
  function r4(i) {
    return i === n.None || i === n.Cancelled || i instanceof We ? true : !i || typeof i != "object" ? false : typeof i.isCancellationRequested == "boolean" && typeof i.onCancellationRequested == "function";
  }
  n.isCancellationToken = r4, n.None = Object.freeze({ isCancellationRequested: false, onCancellationRequested: ie.None }), n.Cancelled = Object.freeze({ isCancellationRequested: true, onCancellationRequested: it });
})(Et ||= {});
var We = class {
  constructor() {
    this._isCancelled = false;
    this._emitter = null;
  }
  cancel() {
    this._isCancelled || (this._isCancelled = true, this._emitter && (this._emitter.fire(void 0), this.dispose()));
  }
  get isCancellationRequested() {
    return this._isCancelled;
  }
  get onCancellationRequested() {
    return this._isCancelled ? it : (this._emitter || (this._emitter = new C()), this._emitter.event);
  }
  dispose() {
    this._emitter && (this._emitter.dispose(), this._emitter = null);
  }
};
var Y = "en", ge = false, _e, ye = Y, rt = Y, Lt, N, W = globalThis, O;
typeof W.vscode < "u" && typeof W.vscode.process < "u" ? O = W.vscode.process : typeof process < "u" && typeof process?.versions?.node == "string" && (O = process);
var ot = typeof O?.versions?.electron == "string", Ot = ot && O?.type === "renderer";
if (typeof O == "object") {
  O.platform === "win32", O.platform === "darwin", ge = O.platform === "linux", ge && !!O.env.SNAP && !!O.env.SNAP_REVISION, !!O.env.CI || !!O.env.BUILD_ARTIFACTSTAGINGDIRECTORY, _e = Y, ye = Y;
  let r4 = O.env.VSCODE_NLS_CONFIG;
  if (r4) try {
    let e = JSON.parse(r4);
    _e = e.userLocale, rt = e.osLocale, ye = e.resolvedLanguage || Y, Lt = e.languagePack?.translationsConfigFile;
  } catch {
  }
} else typeof navigator == "object" && !Ot ? (N = navigator.userAgent, N.indexOf("Windows") >= 0, N.indexOf("Macintosh") >= 0, (N.indexOf("Macintosh") >= 0 || N.indexOf("iPad") >= 0 || N.indexOf("iPhone") >= 0) && !!navigator.maxTouchPoints && navigator.maxTouchPoints > 0, ge = N.indexOf("Linux") >= 0, N?.indexOf("Mobi") >= 0, ye = globalThis._VSCODE_NLS_LANGUAGE || Y, _e = navigator.language.toLowerCase(), rt = _e) : console.error("Unable to resolve platform.");
var M = N, j = ye, Mt;
((n) => {
  function r4() {
    return j;
  }
  n.value = r4;
  function e() {
    return j.length === 2 ? j === "en" : j.length >= 3 ? j[0] === "e" && j[1] === "n" && j[2] === "-" : false;
  }
  n.isDefaultVariant = e;
  function t() {
    return j === "en";
  }
  n.isDefault = t;
})(Mt ||= {});
var Ft = typeof W.postMessage == "function" && !W.importScripts;
(() => {
  if (Ft) {
    let r4 = [];
    W.addEventListener("message", (t) => {
      if (t.data && t.data.vscodeScheduleAsyncWork) for (let n = 0, i = r4.length; n < i; n++) {
        let s = r4[n];
        if (s.id === t.data.vscodeScheduleAsyncWork) {
          r4.splice(n, 1), s.callback();
          return;
        }
      }
    });
    let e = 0;
    return (t) => {
      let n = ++e;
      r4.push({ id: n, callback: t }), W.postMessage({ vscodeScheduleAsyncWork: n }, "*");
    };
  }
  return (r4) => setTimeout(r4);
})();
var Nt = !!(M && M.indexOf("Chrome") >= 0);
!!(M && M.indexOf("Firefox") >= 0);
!!(!Nt && M && M.indexOf("Safari") >= 0);
!!(M && M.indexOf("Edg/") >= 0);
!!(M && M.indexOf("Android") >= 0);
function xe(r4, e = 0, t) {
  let n = setTimeout(() => {
    r4();
  }, e), i = A(() => {
    clearTimeout(n);
  });
  return i;
}
var qt;
((t) => {
  async function r4(n) {
    let i, s = await Promise.all(n.map((a) => a.then((h) => h, (h) => {
      i || (i = h);
    })));
    if (typeof i < "u") throw i;
    return s;
  }
  t.settled = r4;
  function e(n) {
    return new Promise(async (i, s) => {
      try {
        await n(i, s);
      } catch (a) {
        s(a);
      }
    });
  }
  t.withAsyncBody = e;
})(qt ||= {});
var P = class P2 {
  static fromArray(e) {
    return new P2((t) => {
      t.emitMany(e);
    });
  }
  static fromPromise(e) {
    return new P2(async (t) => {
      t.emitMany(await e);
    });
  }
  static fromPromises(e) {
    return new P2(async (t) => {
      await Promise.all(e.map(async (n) => t.emitOne(await n)));
    });
  }
  static merge(e) {
    return new P2(async (t) => {
      await Promise.all(e.map(async (n) => {
        for await (let i of n) t.emitOne(i);
      }));
    });
  }
  constructor(e, t) {
    this._state = 0, this._results = [], this._error = null, this._onReturn = t, this._onStateChanged = new C(), queueMicrotask(async () => {
      let n = { emitOne: (i) => this.emitOne(i), emitMany: (i) => this.emitMany(i), reject: (i) => this.reject(i) };
      try {
        await Promise.resolve(e(n)), this.resolve();
      } catch (i) {
        this.reject(i);
      } finally {
        n.emitOne = void 0, n.emitMany = void 0, n.reject = void 0;
      }
    });
  }
  [Symbol.asyncIterator]() {
    let e = 0;
    return { next: async () => {
      do {
        if (this._state === 2) throw this._error;
        if (e < this._results.length) return { done: false, value: this._results[e++] };
        if (this._state === 1) return { done: true, value: void 0 };
        await ie.toPromise(this._onStateChanged.event);
      } while (true);
    }, return: async () => (this._onReturn?.(), { done: true, value: void 0 }) };
  }
  static map(e, t) {
    return new P2(async (n) => {
      for await (let i of e) n.emitOne(t(i));
    });
  }
  map(e) {
    return P2.map(this, e);
  }
  static filter(e, t) {
    return new P2(async (n) => {
      for await (let i of e) t(i) && n.emitOne(i);
    });
  }
  filter(e) {
    return P2.filter(this, e);
  }
  static coalesce(e) {
    return P2.filter(e, (t) => !!t);
  }
  coalesce() {
    return P2.coalesce(this);
  }
  static async toPromise(e) {
    let t = [];
    for await (let n of e) t.push(n);
    return t;
  }
  toPromise() {
    return P2.toPromise(this);
  }
  emitOne(e) {
    this._state === 0 && (this._results.push(e), this._onStateChanged.fire());
  }
  emitMany(e) {
    this._state === 0 && (this._results = this._results.concat(e), this._onStateChanged.fire());
  }
  resolve() {
    this._state === 0 && (this._state = 1, this._onStateChanged.fire());
  }
  reject(e) {
    this._state === 0 && (this._state = 2, this._error = e, this._onStateChanged.fire());
  }
};
P.EMPTY = P.fromArray([]);
var Ie = class extends k {
  constructor(t) {
    super();
    this._terminal = t;
    this._linesCacheTimeout = this._register(new F());
    this._linesCacheDisposables = this._register(new F());
    this._register(A(() => this._destroyLinesCache()));
  }
  initLinesCache() {
    this._linesCache || (this._linesCache = new Array(this._terminal.buffer.active.length), this._linesCacheDisposables.value = me(this._terminal.onLineFeed(() => this._destroyLinesCache()), this._terminal.onCursorMove(() => this._destroyLinesCache()), this._terminal.onResize(() => this._destroyLinesCache()))), this._linesCacheTimeout.value = xe(() => this._destroyLinesCache(), 15e3);
  }
  _destroyLinesCache() {
    this._linesCache = void 0, this._linesCacheDisposables.clear(), this._linesCacheTimeout.clear();
  }
  getLineFromCache(t) {
    return this._linesCache?.[t];
  }
  setLineInCache(t, n) {
    this._linesCache && (this._linesCache[t] = n);
  }
  translateBufferLineToStringWithWrap(t, n) {
    let i = [], s = [0], a = this._terminal.buffer.active.getLine(t);
    for (; a; ) {
      let h = this._terminal.buffer.active.getLine(t + 1), u = h ? h.isWrapped : false, p = a.translateToString(!u && n);
      if (u && h) {
        let T = a.getCell(a.length - 1);
        T && T.getCode() === 0 && T.getWidth() === 1 && h.getCell(0)?.getWidth() === 2 && (p = p.slice(0, -1));
      }
      if (i.push(p), u) s.push(s[s.length - 1] + p.length);
      else break;
      t++, a = h;
    }
    return [i.join(""), s];
  }
};
var De = class {
  get cachedSearchTerm() {
    return this._cachedSearchTerm;
  }
  set cachedSearchTerm(e) {
    this._cachedSearchTerm = e;
  }
  get lastSearchOptions() {
    return this._lastSearchOptions;
  }
  set lastSearchOptions(e) {
    this._lastSearchOptions = e;
  }
  isValidSearchTerm(e) {
    return !!(e && e.length > 0);
  }
  didOptionsChange(e) {
    return this._lastSearchOptions ? e ? this._lastSearchOptions.caseSensitive !== e.caseSensitive || this._lastSearchOptions.regex !== e.regex || this._lastSearchOptions.wholeWord !== e.wholeWord : false : true;
  }
  shouldUpdateHighlighting(e, t) {
    return t?.decorations ? this._cachedSearchTerm === void 0 || e !== this._cachedSearchTerm || this.didOptionsChange(t) : false;
  }
  clearCachedTerm() {
    this._cachedSearchTerm = void 0;
  }
  reset() {
    this._cachedSearchTerm = void 0, this._lastSearchOptions = void 0;
  }
};
var Ee = class {
  constructor(e, t) {
    this._terminal = e;
    this._lineCache = t;
  }
  find(e, t, n, i) {
    if (!e || e.length === 0) {
      this._terminal.clearSelection();
      return;
    }
    if (n > this._terminal.cols) throw new Error(`Invalid col: ${n} to search in terminal of ${this._terminal.cols} cols`);
    this._lineCache.initLinesCache();
    let s = { startRow: t, startCol: n }, a = this._findInLine(e, s, i);
    if (!a) for (let h = t + 1; h < this._terminal.buffer.active.baseY + this._terminal.rows && (s.startRow = h, s.startCol = 0, a = this._findInLine(e, s, i), !a); h++) ;
    return a;
  }
  findNextWithSelection(e, t, n) {
    if (!e || e.length === 0) {
      this._terminal.clearSelection();
      return;
    }
    let i = this._terminal.getSelectionPosition();
    this._terminal.clearSelection();
    let s = 0, a = 0;
    i && (n === e ? (s = i.end.x, a = i.end.y) : (s = i.start.x, a = i.start.y)), this._lineCache.initLinesCache();
    let h = { startRow: a, startCol: s }, u = this._findInLine(e, h, t);
    if (!u) for (let p = a + 1; p < this._terminal.buffer.active.baseY + this._terminal.rows && (h.startRow = p, h.startCol = 0, u = this._findInLine(e, h, t), !u); p++) ;
    if (!u && a !== 0) for (let p = 0; p < a && (h.startRow = p, h.startCol = 0, u = this._findInLine(e, h, t), !u); p++) ;
    return !u && i && (h.startRow = i.start.y, h.startCol = 0, u = this._findInLine(e, h, t)), u;
  }
  findPreviousWithSelection(e, t, n) {
    if (!e || e.length === 0) {
      this._terminal.clearSelection();
      return;
    }
    let i = this._terminal.getSelectionPosition();
    this._terminal.clearSelection();
    let s = this._terminal.buffer.active.baseY + this._terminal.rows - 1, a = this._terminal.cols, h = true;
    this._lineCache.initLinesCache();
    let u = { startRow: s, startCol: a }, p;
    if (i && (u.startRow = s = i.start.y, u.startCol = a = i.start.x, n !== e && (p = this._findInLine(e, u, t, false), p || (u.startRow = s = i.end.y, u.startCol = a = i.end.x))), p || (p = this._findInLine(e, u, t, h)), !p) {
      u.startCol = Math.max(u.startCol, this._terminal.cols);
      for (let T = s - 1; T >= 0 && (u.startRow = T, p = this._findInLine(e, u, t, h), !p); T--) ;
    }
    if (!p && s !== this._terminal.buffer.active.baseY + this._terminal.rows - 1) for (let T = this._terminal.buffer.active.baseY + this._terminal.rows - 1; T >= s && (u.startRow = T, p = this._findInLine(e, u, t, h), !p); T--) ;
    return p;
  }
  _isWholeWord(e, t, n) {
    return (e === 0 || " ~!@#$%^&*()+`-=[]{}|\\;:\"',./<>?".includes(t[e - 1])) && (e + n.length === t.length || " ~!@#$%^&*()+`-=[]{}|\\;:\"',./<>?".includes(t[e + n.length]));
  }
  _findInLine(e, t, n = {}, i = false) {
    let s = t.startRow, a = t.startCol;
    if (this._terminal.buffer.active.getLine(s)?.isWrapped) {
      if (i) {
        t.startCol += this._terminal.cols;
        return;
      }
      return t.startRow--, t.startCol += this._terminal.cols, this._findInLine(e, t, n);
    }
    let u = this._lineCache.getLineFromCache(s);
    u || (u = this._lineCache.translateBufferLineToStringWithWrap(s, true), this._lineCache.setLineInCache(s, u));
    let [p, T] = u, v = this._bufferColsToStringOffset(s, a), I = e, E = p;
    n.regex || (I = n.caseSensitive ? e : e.toLowerCase(), E = n.caseSensitive ? p : p.toLowerCase());
    let S = -1;
    if (n.regex) {
      let D = RegExp(I, n.caseSensitive ? "g" : "gi"), x;
      if (i) for (; x = D.exec(E.slice(0, v)); ) S = D.lastIndex - x[0].length, e = x[0], D.lastIndex -= e.length - 1;
      else x = D.exec(E.slice(v)), x && x[0].length > 0 && (S = v + (D.lastIndex - x[0].length), e = x[0]);
    } else i ? v - I.length >= 0 && (S = E.lastIndexOf(I, v - I.length)) : S = E.indexOf(I, v);
    if (S >= 0) {
      if (n.wholeWord && !this._isWholeWord(S, E, e)) return;
      let D = 0;
      for (; D < T.length - 1 && S >= T[D + 1]; ) D++;
      let x = D;
      for (; x < T.length - 1 && S + e.length >= T[x + 1]; ) x++;
      let J = S - T[D], q = S + e.length - T[x], z = this._stringLengthToBufferSize(s + D, J), _ = this._stringLengthToBufferSize(s + x, q) - z + this._terminal.cols * (x - D);
      return { term: e, col: z, row: s + D, size: _ };
    }
  }
  _stringLengthToBufferSize(e, t) {
    let n = this._terminal.buffer.active.getLine(e);
    if (!n) return 0;
    for (let i = 0; i < t; i++) {
      let s = n.getCell(i);
      if (!s) break;
      let a = s.getChars();
      a.length > 1 && (t -= a.length - 1);
      let h = n.getCell(i + 1);
      h && h.getWidth() === 0 && t++;
    }
    return t;
  }
  _bufferColsToStringOffset(e, t) {
    let n = e, i = 0, s = this._terminal.buffer.active.getLine(n);
    for (; t > 0 && s; ) {
      for (let a = 0; a < t && a < this._terminal.cols; a++) {
        let h = s.getCell(a);
        if (!h) break;
        h.getWidth() && (i += h.getCode() === 0 ? 1 : h.getChars().length);
      }
      if (n++, s = this._terminal.buffer.active.getLine(n), s && !s.isWrapped) break;
      t -= this._terminal.cols;
    }
    return i;
  }
};
var we = class extends k {
  constructor(t) {
    super();
    this._terminal = t;
    this._highlightDecorations = [];
    this._highlightedLines = /* @__PURE__ */ new Set();
    this._register(A(() => this.clearHighlightDecorations()));
  }
  createHighlightDecorations(t, n) {
    this.clearHighlightDecorations();
    for (let i of t) {
      let s = this._createResultDecorations(i, n, false);
      if (s) for (let a of s) this._storeDecoration(a, i);
    }
  }
  createActiveDecoration(t, n) {
    let i = this._createResultDecorations(t, n, true);
    if (i) return { decorations: i, match: t, dispose() {
      Q(i);
    } };
  }
  clearHighlightDecorations() {
    Q(this._highlightDecorations), this._highlightDecorations = [], this._highlightedLines.clear();
  }
  _storeDecoration(t, n) {
    this._highlightedLines.add(t.marker.line), this._highlightDecorations.push({ decoration: t, match: n, dispose() {
      t.dispose();
    } });
  }
  _applyStyles(t, n, i) {
    t.classList.contains("xterm-find-result-decoration") || (t.classList.add("xterm-find-result-decoration"), n && (t.style.outline = `1px solid ${n}`)), i && t.classList.add("xterm-find-active-result-decoration");
  }
  _createResultDecorations(t, n, i) {
    let s = [], a = t.col, h = t.size, u = -this._terminal.buffer.active.baseY - this._terminal.buffer.active.cursorY + t.row;
    for (; h > 0; ) {
      let T = Math.min(this._terminal.cols - a, h);
      s.push([u, a, T]), a = 0, h -= T, u++;
    }
    let p = [];
    for (let T of s) {
      let v = this._terminal.registerMarker(T[0]), I = this._terminal.registerDecoration({ marker: v, x: T[1], width: T[2], backgroundColor: i ? n.activeMatchBackground : n.matchBackground, overviewRulerOptions: this._highlightedLines.has(v.line) ? void 0 : { color: i ? n.activeMatchColorOverviewRuler : n.matchOverviewRuler, position: "center" } });
      if (I) {
        let E = [];
        E.push(v), E.push(I.onRender((S) => this._applyStyles(S, i ? n.activeMatchBorder : n.matchBorder, false))), E.push(I.onDispose(() => Q(E))), p.push(I);
      }
    }
    return p.length === 0 ? void 0 : p;
  }
};
var ke = class extends k {
  constructor() {
    super(...arguments);
    this._searchResults = [];
    this._onDidChangeResults = this._register(new C());
  }
  get onDidChangeResults() {
    return this._onDidChangeResults.event;
  }
  get searchResults() {
    return this._searchResults;
  }
  get selectedDecoration() {
    return this._selectedDecoration;
  }
  set selectedDecoration(t) {
    this._selectedDecoration = t;
  }
  updateResults(t, n) {
    this._searchResults = t.slice(0, n);
  }
  clearResults() {
    this._searchResults = [];
  }
  clearSelectedDecoration() {
    this._selectedDecoration && (this._selectedDecoration.dispose(), this._selectedDecoration = void 0);
  }
  findResultIndex(t) {
    for (let n = 0; n < this._searchResults.length; n++) {
      let i = this._searchResults[n];
      if (i.row === t.row && i.col === t.col && i.size === t.size) return n;
    }
    return -1;
  }
  fireResultsChanged(t) {
    if (!t) return;
    let n = -1;
    this._selectedDecoration && (n = this.findResultIndex(this._selectedDecoration.match)), this._onDidChangeResults.fire({ resultIndex: n, resultCount: this._searchResults.length });
  }
  reset() {
    this.clearSelectedDecoration(), this.clearResults();
  }
};
var ut = class extends k {
  constructor(t) {
    super();
    this._highlightTimeout = this._register(new F());
    this._lineCache = this._register(new F());
    this._state = new De();
    this._resultTracker = this._register(new ke());
    this._highlightLimit = t?.highlightLimit ?? 1e3;
  }
  get onDidChangeResults() {
    return this._resultTracker.onDidChangeResults;
  }
  activate(t) {
    this._terminal = t, this._lineCache.value = new Ie(t), this._engine = new Ee(t, this._lineCache.value), this._decorationManager = new we(t), this._register(this._terminal.onWriteParsed(() => this._updateMatches())), this._register(this._terminal.onResize(() => this._updateMatches())), this._register(A(() => this.clearDecorations()));
  }
  _updateMatches() {
    this._highlightTimeout.clear(), this._state.cachedSearchTerm && this._state.lastSearchOptions?.decorations && (this._highlightTimeout.value = xe(() => {
      let t = this._state.cachedSearchTerm;
      this._state.clearCachedTerm(), this.findPrevious(t, { ...this._state.lastSearchOptions, incremental: true }, { noScroll: true });
    }, 200));
  }
  clearDecorations(t) {
    this._resultTracker.clearSelectedDecoration(), this._decorationManager?.clearHighlightDecorations(), this._resultTracker.clearResults(), t || this._state.clearCachedTerm();
  }
  clearActiveDecoration() {
    this._resultTracker.clearSelectedDecoration();
  }
  findNext(t, n, i) {
    if (!this._terminal || !this._engine) throw new Error("Cannot use addon until it has been loaded");
    this._state.lastSearchOptions = n, this._state.shouldUpdateHighlighting(t, n) && this._highlightAllMatches(t, n);
    let s = this._findNextAndSelect(t, n, i);
    return this._fireResults(n), this._state.cachedSearchTerm = t, s;
  }
  _highlightAllMatches(t, n) {
    if (!this._terminal || !this._engine || !this._decorationManager) throw new Error("Cannot use addon until it has been loaded");
    if (!this._state.isValidSearchTerm(t)) {
      this.clearDecorations();
      return;
    }
    this.clearDecorations(true);
    let i = [], s, a = this._engine.find(t, 0, 0, n);
    for (; a && (s?.row !== a.row || s?.col !== a.col) && !(i.length >= this._highlightLimit); ) s = a, i.push(s), a = this._engine.find(t, s.col + s.term.length >= this._terminal.cols ? s.row + 1 : s.row, s.col + s.term.length >= this._terminal.cols ? 0 : s.col + 1, n);
    this._resultTracker.updateResults(i, this._highlightLimit), n.decorations && this._decorationManager.createHighlightDecorations(i, n.decorations);
  }
  _findNextAndSelect(t, n, i) {
    if (!this._terminal || !this._engine) return false;
    if (!this._state.isValidSearchTerm(t)) return this._terminal.clearSelection(), this.clearDecorations(), false;
    let s = this._engine.findNextWithSelection(t, n, this._state.cachedSearchTerm);
    return this._selectResult(s, n?.decorations, i?.noScroll);
  }
  findPrevious(t, n, i) {
    if (!this._terminal || !this._engine) throw new Error("Cannot use addon until it has been loaded");
    this._state.lastSearchOptions = n, this._state.shouldUpdateHighlighting(t, n) && this._highlightAllMatches(t, n);
    let s = this._findPreviousAndSelect(t, n, i);
    return this._fireResults(n), this._state.cachedSearchTerm = t, s;
  }
  _fireResults(t) {
    this._resultTracker.fireResultsChanged(!!t?.decorations);
  }
  _findPreviousAndSelect(t, n, i) {
    if (!this._terminal || !this._engine) return false;
    if (!this._state.isValidSearchTerm(t)) return this._terminal.clearSelection(), this.clearDecorations(), false;
    let s = this._engine.findPreviousWithSelection(t, n, this._state.cachedSearchTerm);
    return this._selectResult(s, n?.decorations, i?.noScroll);
  }
  _selectResult(t, n, i) {
    if (!this._terminal || !this._decorationManager) return false;
    if (this._resultTracker.clearSelectedDecoration(), !t) return this._terminal.clearSelection(), false;
    if (this._terminal.select(t.col, t.row, t.size), n) {
      let s = this._decorationManager.createActiveDecoration(t, n);
      s && (this._resultTracker.selectedDecoration = s);
    }
    if (!i && (t.row >= this._terminal.buffer.active.viewportY + this._terminal.rows || t.row < this._terminal.buffer.active.viewportY)) {
      let s = t.row - this._terminal.buffer.active.viewportY;
      s -= Math.floor(this._terminal.rows / 2), this._terminal.scrollLines(s);
    }
    return true;
  }
};
export {
  ut as SearchAddon
};
