import{i as s,b as p,Z as te,x as ne,K as se,t as k,n as oe,aa as ae,L as re,ab as u}from"./iframe-D288tw9h.js";import{T as C,A as M}from"./tool-status-title-DzUHkAKI.js";import"./preload-helper-D9Z9MdNV.js";import"./text-shimmer-SJimTaBu.js";var ie=k('<div style=display:grid;gap:24px;padding:20px;max-width:520px><span style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500;color:var(--text-strong, #eee);min-width:0"><span style=flex-shrink:0></span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;color:var(--text-base, #ccc)"></span></span><div style=display:flex;gap:8px;flex-wrap:wrap><button></button><button>Reset</button><button></button></div><div style=display:flex;gap:8px;flex-wrap:wrap><button>+ read</button><button>+ search</button><button>+ list</button></div><div style="font-size:11px;color:var(--color-text-weak, #888);font-family:monospace">motion: <!> · active: <!> · reads: <!> · searches: <!> · lists: '),le=k(`<style>[data-reduced-motion="true"] *,
              [data-reduced-motion="true"] *::before,
              [data-reduced-motion="true"] *::after {
                transition-duration: 0ms !important;
              }`),ce=k("<span style=display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500>"),de=k('<span style=display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500><span style="font-weight:400;color:var(--text-base, #ccc)">');const xe={title:"UI/AnimatedCountList",id:"components-animated-count-list",tags:["autodocs"],parameters:{docs:{description:{component:`### Overview
Animated count list that smoothly transitions items in/out as counts change.

Uses \`grid-template-columns: 0fr → 1fr\` for width animations and the odometer
digit roller for count transitions. Shown here with \`ToolStatusTitle\` exactly
as it appears in the context tool group on the session page.`}}}},r={active:"Exploring",done:"Explored",read:{one:"{{count}} read",other:"{{count}} reads"},search:{one:"{{count}} search",other:"{{count}} searches"},list:{one:"{{count}} list",other:"{{count}} lists"}};function E(t,n){return Math.floor(Math.random()*(n-t+1))+t}const K=t=>({padding:"6px 14px","border-radius":"6px",border:"1px solid var(--color-divider, #333)",background:t?"var(--color-danger-fill, #c33)":"var(--color-fill-element, #222)",color:"var(--color-text, #eee)",cursor:"pointer","font-size":"13px"}),y=t=>({padding:"4px 12px","border-radius":"6px",border:t?"1px solid var(--color-accent, #58f)":"1px solid var(--color-divider, #333)",background:t?"var(--color-accent, #58f)":"var(--color-fill-element, #222)",color:"var(--color-text, #eee)",cursor:"pointer","font-size":"12px"}),b={render:()=>{const[t,n]=te({reads:0,searches:0,lists:0,active:!1,reducedMotion:!1}),A=()=>t.reads,z=()=>t.searches,X=()=>t.lists,m=()=>t.active,h=()=>t.reducedMotion;let x=[];const w=()=>{for(const i of x)clearTimeout(i);x=[]};oe(w);const Z=()=>{w(),n("reads",0),n("searches",0),n("lists",0),n("active",!0);const i=E(3,10);let a=0;for(let f=0;f<i;f++){const g=E(300,800);a+=g;const l=setTimeout(()=>{const c=E(0,2);c===0?n("reads",o=>o+1):c===1?n("searches",o=>o+1):n("lists",o=>o+1)},a);x.push(l)}const v=setTimeout(()=>n("active",!1),a+100);x.push(v)},L=()=>{w(),n("active",!1)},j=()=>{L(),n("reads",0),n("searches",0),n("lists",0)},q=()=>[{key:"read",count:A(),one:r.read.one,other:r.read.other},{key:"search",count:z(),one:r.search.one,other:r.search.other},{key:"list",count:X(),one:r.list.one,other:r.list.other}];return(()=>{var i=ie(),a=i.firstChild,v=a.firstChild,f=v.nextSibling,g=a.nextSibling,l=g.firstChild,c=l.nextSibling,o=c.nextSibling,B=g.nextSibling,$=B.firstChild,_=$.nextSibling,R=_.nextSibling,d=B.nextSibling,F=d.firstChild,D=F.nextSibling,G=D.nextSibling,I=G.nextSibling,H=I.nextSibling,O=H.nextSibling,J=O.nextSibling,P=J.nextSibling;return P.nextSibling,s(i,(()=>{var e=ne(()=>!!h());return()=>e()&&le()})(),a),s(v,p(C,{get active(){return m()},get activeText(){return r.active},get doneText(){return r.done},split:!1})),s(f,p(M,{get items(){return q()},fallback:""})),l.$$click=()=>m()?L():Z(),s(l,()=>m()?"Stop":"Simulate"),c.$$click=j,o.$$click=()=>n("reducedMotion",e=>!e),s(o,()=>h()?"Motion: reduced":"Motion: normal"),$.$$click=()=>n("reads",e=>e+1),_.$$click=()=>n("searches",e=>e+1),R.$$click=()=>n("lists",e=>e+1),s(d,()=>h()?"reduced":"normal",D),s(d,()=>m()?"true":"false",I),s(d,A,O),s(d,z,P),s(d,X,null),se(e=>{var U=h(),N=K(m()),Q=K(),V=y(h()),W=y(),Y=y(),ee=y();return U!==e.e&&re(a,"data-reduced-motion",e.e=U),e.t=u(l,N,e.t),e.a=u(c,Q,e.a),e.o=u(o,V,e.o),e.i=u($,W,e.i),e.n=u(_,Y,e.n),e.s=u(R,ee,e.s),e},{e:void 0,t:void 0,a:void 0,o:void 0,i:void 0,n:void 0,s:void 0}),i})()}},S={render:()=>(()=>{var t=ce();return s(t,p(C,{active:!0,activeText:"Exploring",doneText:"Explored",split:!1}),null),s(t,p(M,{items:[{key:"read",count:0,one:"{{count}} read",other:"{{count}} reads"},{key:"search",count:0,one:"{{count}} search",other:"{{count}} searches"}],fallback:""}),null),t})()},T={render:()=>(()=>{var t=de(),n=t.firstChild;return s(t,p(C,{active:!1,activeText:"Exploring",doneText:"Explored",split:!1}),n),s(n,p(M,{items:[{key:"read",count:5,one:"{{count}} read",other:"{{count}} reads"},{key:"search",count:3,one:"{{count}} search",other:"{{count}} searches"},{key:"list",count:1,one:"{{count}} list",other:"{{count}} lists"}],fallback:""})),t})()};b.parameters={...b.parameters,docs:{...b.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [state, setState] = createStore({
      reads: 0,
      searches: 0,
      lists: 0,
      active: false,
      reducedMotion: false
    });
    const reads = () => state.reads;
    const searches = () => state.searches;
    const lists = () => state.lists;
    const active = () => state.active;
    const reducedMotion = () => state.reducedMotion;
    let timeouts: ReturnType<typeof setTimeout>[] = [];
    const clearAll = () => {
      for (const t of timeouts) clearTimeout(t);
      timeouts = [];
    };
    onCleanup(clearAll);
    const startSim = () => {
      clearAll();
      setState("reads", 0);
      setState("searches", 0);
      setState("lists", 0);
      setState("active", true);
      const steps = rand(3, 10);
      let elapsed = 0;
      for (let i = 0; i < steps; i++) {
        const delay = rand(300, 800);
        elapsed += delay;
        const t = setTimeout(() => {
          const pick = rand(0, 2);
          if (pick === 0) setState("reads", value => value + 1);else if (pick === 1) setState("searches", value => value + 1);else setState("lists", value => value + 1);
        }, elapsed);
        timeouts.push(t);
      }
      const end = setTimeout(() => setState("active", false), elapsed + 100);
      timeouts.push(end);
    };
    const stopSim = () => {
      clearAll();
      setState("active", false);
    };
    const reset = () => {
      stopSim();
      setState("reads", 0);
      setState("searches", 0);
      setState("lists", 0);
    };
    const items = (): CountItem[] => [{
      key: "read",
      count: reads(),
      one: TEXT.read.one,
      other: TEXT.read.other
    }, {
      key: "search",
      count: searches(),
      one: TEXT.search.one,
      other: TEXT.search.other
    }, {
      key: "list",
      count: lists(),
      one: TEXT.list.one,
      other: TEXT.list.other
    }];
    return <div style={{
      display: "grid",
      gap: "24px",
      padding: "20px",
      "max-width": "520px"
    }}>
        {reducedMotion() && <style>
            {\`[data-reduced-motion="true"] *,
              [data-reduced-motion="true"] *::before,
              [data-reduced-motion="true"] *::after {
                transition-duration: 0ms !important;
              }\`}
          </style>}

        {/* Matches context-tool-group-trigger layout from message-part.tsx */}
        <span data-reduced-motion={reducedMotion()} style={{
        display: "flex",
        "align-items": "center",
        gap: "8px",
        "font-size": "14px",
        "font-weight": "500",
        color: "var(--text-strong, #eee)",
        "min-width": "0"
      }}>
          <span style={{
          "flex-shrink": "0"
        }}>
            <ToolStatusTitle active={active()} activeText={TEXT.active} doneText={TEXT.done} split={false} />
          </span>
          <span style={{
          "min-width": "0",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
          "font-weight": "400",
          color: "var(--text-base, #ccc)"
        }}>
            <AnimatedCountList items={items()} fallback="" />
          </span>
        </span>

        <div style={{
        display: "flex",
        gap: "8px",
        "flex-wrap": "wrap"
      }}>
          <button onClick={() => active() ? stopSim() : startSim()} style={btn(active())}>
            {active() ? "Stop" : "Simulate"}
          </button>
          <button onClick={reset} style={btn()}>
            Reset
          </button>
          <button onClick={() => setState("reducedMotion", value => !value)} style={smallBtn(reducedMotion())}>
            {reducedMotion() ? "Motion: reduced" : "Motion: normal"}
          </button>
        </div>

        <div style={{
        display: "flex",
        gap: "8px",
        "flex-wrap": "wrap"
      }}>
          <button onClick={() => setState("reads", value => value + 1)} style={smallBtn()}>
            + read
          </button>
          <button onClick={() => setState("searches", value => value + 1)} style={smallBtn()}>
            + search
          </button>
          <button onClick={() => setState("lists", value => value + 1)} style={smallBtn()}>
            + list
          </button>
        </div>

        <div style={{
        "font-size": "11px",
        color: "var(--color-text-weak, #888)",
        "font-family": "monospace"
      }}>
          motion: {reducedMotion() ? "reduced" : "normal"} · active: {active() ? "true" : "false"} · reads: {reads()} ·
          searches: {searches()} · lists: {lists()}
        </div>
      </div>;
  }
}`,...b.parameters?.docs?.source}}};S.parameters={...S.parameters,docs:{...S.parameters?.docs,source:{originalSource:`{
  render: () => <span style={{
    display: "flex",
    "align-items": "center",
    gap: "8px",
    "font-size": "14px",
    "font-weight": "500"
  }}>
      <ToolStatusTitle active activeText="Exploring" doneText="Explored" split={false} />
      <AnimatedCountList items={[{
      key: "read",
      count: 0,
      one: "{{count}} read",
      other: "{{count}} reads"
    }, {
      key: "search",
      count: 0,
      one: "{{count}} search",
      other: "{{count}} searches"
    }]} fallback="" />
    </span>
}`,...S.parameters?.docs?.source}}};T.parameters={...T.parameters,docs:{...T.parameters?.docs,source:{originalSource:`{
  render: () => <span style={{
    display: "flex",
    "align-items": "center",
    gap: "8px",
    "font-size": "14px",
    "font-weight": "500"
  }}>
      <ToolStatusTitle active={false} activeText="Exploring" doneText="Explored" split={false} />
      <span style={{
      "font-weight": "400",
      color: "var(--text-base, #ccc)"
    }}>
        <AnimatedCountList items={[{
        key: "read",
        count: 5,
        one: "{{count}} read",
        other: "{{count}} reads"
      }, {
        key: "search",
        count: 3,
        one: "{{count}} search",
        other: "{{count}} searches"
      }, {
        key: "list",
        count: 1,
        one: "{{count}} list",
        other: "{{count}} lists"
      }]} fallback="" />
      </span>
    </span>
}`,...T.parameters?.docs?.source}}};ae(["click"]);const ve=["Playground","Empty","Done"];export{T as Done,S as Empty,b as Playground,ve as __namedExportsOrder,xe as default};
