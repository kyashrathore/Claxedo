import{Z as $e,i,b as X,K as p,t as S,n as Te,aa as _e,a9 as P,ab as a,a as Ce,ad as Y}from"./iframe-D288tw9h.js";import{B as ke,a as ee}from"./basic-tool-Bj_cFKt0.js";import"./preload-helper-D9Z9MdNV.js";import"./i18n-CW9P7x91.js";import"./collapsible-Du8zhFL1.js";import"./UGE6PPGT-C6B63Gso.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";import"./text-shimmer-SJimTaBu.js";import"./is-motion-value-DTVMTkbm.js";var De=S("<span data-component=shell-submessage><span data-slot=shell-submessage-width style=width:0px><span data-slot=basic-tool-tool-subtitle><span data-slot=shell-submessage-value>"),Me=S(`<div style="border-radius:8px;border:1px solid var(--color-divider, #333);background:var(--color-fill-secondary, #161616);padding:14px 16px;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;font-size:18px;color:var(--color-text, #eee);white-space:pre-wrap">$ cat &lt;&lt;'TOPIC1'`),Ie=S(`<div data-component=shell-submessage-scene style=display:grid;gap:20px;padding:20px;max-width:860px><style>
[data-component="shell-submessage-scene"] [data-component="tool-trigger"] [data-slot="basic-tool-tool-info-main"] {
  align-items: baseline;
}

[data-component="shell-submessage"] {
  min-width: 0;
  max-width: 100%;
  display: inline-flex;
  align-items: baseline;
  vertical-align: baseline;
}

[data-component="shell-submessage"] [data-slot="shell-submessage-width"] {
  min-width: 0;
  max-width: 100%;
  display: inline-flex;
  align-items: baseline;
  overflow: hidden;
}

[data-component="shell-submessage"] [data-slot="shell-submessage-value"] {
  display: inline-block;
  vertical-align: baseline;
  min-width: 0;
  line-height: inherit;
  white-space: nowrap;
  opacity: 0;
  filter: blur(var(--shell-sub-blur, 2px));
  transition-property: opacity, filter;
  transition-duration: var(--shell-sub-fade-ms, 320ms);
  transition-timing-function: var(--shell-sub-fade-ease, cubic-bezier(0.22, 1, 0.36, 1));
}

[data-component="shell-submessage"][data-visible] [data-slot="shell-submessage-value"] {
  opacity: 1;
  filter: blur(0px);
}
</style><div style=display:flex;gap:8px;flex-wrap:wrap><button>Replay entry</button><button></button><button></button></div><div style="display:grid;gap:10px;border-top:1px solid var(--color-divider, #333);padding-top:14px"><div style=display:flex;align-items:center;gap:12px><span>subtitle</span><input style="width:420px;max-width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--color-divider, #333);background:var(--color-fill-element, #222);color:var(--color-text, #eee)"></div><div style=display:flex;align-items:center;gap:12px><span>visualDuration</span><input type=range min=0.05 max=1.5 step=0.01><span>s</span></div><div style=display:flex;align-items:center;gap:12px><span>bounce</span><input type=range min=0 max=0.5 step=0.01><span></span></div><div style=display:flex;align-items:center;gap:12px><span>fade ease</span><button></button></div><div style=display:flex;align-items:center;gap:12px><span>fade</span><input type=range min=0 max=1400 step=10><span>ms</span></div><div style=display:flex;align-items:center;gap:12px><span>blur</span><input type=range min=0 max=14 step=0.5><span>px`),Ee=S("<div data-slot=basic-tool-tool-info-structured><div data-slot=basic-tool-tool-info-main><span data-slot=basic-tool-tool-title>Shell");const Ke={title:"UI/Shell Submessage Motion",id:"components-shell-submessage-motion",tags:["autodocs"],parameters:{docs:{description:{component:'### Overview\nInteractive playground for animating the Shell tool subtitle ("submessage") in the timeline trigger row.\n\n### Production component path\n- Trigger layout: `packages/ui/src/components/basic-tool.tsx`\n- Bash tool subtitle source: `packages/ui/src/components/message-part.tsx` (tool: `bash`, `trigger.subtitle`)\n\n### What this playground tunes\n- Width reveal (spring-driven pixel width via `useSpring`)\n- Opacity fade\n- Blur settle'}}}},y=t=>({padding:"6px 14px","border-radius":"6px",border:"1px solid var(--color-divider, #333)",background:t?"var(--color-accent, #58f)":"var(--color-fill-element, #222)",color:"var(--color-text, #eee)",cursor:"pointer","font-size":"13px"}),c={"font-size":"11px","font-family":"monospace",color:"var(--color-text-weak, #666)","min-width":"84px","flex-shrink":"0","text-align":"right"},h={"font-family":"monospace","font-size":"11px",color:"var(--color-text-weak, #aaa)","min-width":"76px"},Ae={smooth:"cubic-bezier(0.16, 1, 0.3, 1)",snappy:"cubic-bezier(0.22, 1, 0.36, 1)",standard:"cubic-bezier(0.2, 0.8, 0.2, 1)",linear:"linear"};function ze(t){let n,s;return Ce(()=>{s&&(t.visible?requestAnimationFrame(()=>{n?.setAttribute("data-visible",""),ee(s,{width:"auto"},{type:"spring",visualDuration:t.visualDuration,bounce:t.bounce})}):(n?.removeAttribute("data-visible"),ee(s,{width:"0px"},{type:"spring",visualDuration:t.visualDuration,bounce:t.bounce})))}),(()=>{var l=De(),o=l.firstChild,b=o.firstChild,v=b.firstChild,r=n;typeof r=="function"?Y(r,l):n=l;var m=s;return typeof m=="function"?Y(m,o):s=o,i(v,()=>t.text||" "),l})()}const w={render:()=>{const[t,n]=$e({text:"Prints five topic blocks between timed commands",show:!0,visualDuration:.35,bounce:0,fadeMs:320,blur:2,fadeEase:"snappy",auto:!1}),s=()=>t.text,l=()=>t.show,o=()=>t.visualDuration,b=()=>t.bounce,v=()=>t.fadeMs,r=()=>t.blur,m=()=>t.fadeEase,$=()=>t.auto;let g,u;const F=()=>{n("show",!1),g&&clearTimeout(g),g=setTimeout(()=>{n("show",!0)},50)},te=()=>{u&&clearInterval(u),u=void 0,n("auto",!1)},ne=()=>{if($()){te();return}n("auto",!0),u=setInterval(F,2200)};return Te(()=>{g&&clearTimeout(g),u&&clearInterval(u)}),(()=>{var d=Ie(),ae=d.firstChild,T=ae.nextSibling,_=T.firstChild,f=_.nextSibling,C=f.nextSibling,ie=T.nextSibling,L=ie.firstChild,O=L.firstChild,B=O.nextSibling,R=L.nextSibling,V=R.firstChild,k=V.nextSibling,D=k.nextSibling,se=D.firstChild,H=R.nextSibling,W=H.firstChild,M=W.nextSibling,q=M.nextSibling,K=H.nextSibling,U=K.firstChild,I=U.nextSibling,Z=K.nextSibling,j=Z.firstChild,E=j.nextSibling,A=E.nextSibling,le=A.firstChild,oe=Z.nextSibling,G=oe.firstChild,z=G.nextSibling,N=z.nextSibling,re=N.firstChild;return i(d,X(ke,{icon:"terminal",defaultOpen:!0,get trigger(){return(()=>{var e=Ee(),x=e.firstChild;return x.firstChild,i(x,X(ze,{get text(){return s()},get visible(){return l()},get visualDuration(){return o()},get bounce(){return b()}}),null),e})()},get children(){return Me()}}),T),_.$$click=F,f.$$click=()=>n("show",e=>!e),i(f,()=>l()?"Hide subtitle":"Show subtitle"),C.$$click=ne,i(C,()=>$()?"Stop auto replay":"Auto replay"),B.$$input=e=>n("text",e.currentTarget.value),k.$$input=e=>n("visualDuration",Number(e.currentTarget.value)),i(D,()=>o().toFixed(2),se),M.$$input=e=>n("bounce",Number(e.currentTarget.value)),i(q,()=>b().toFixed(2)),I.$$click=()=>n("fadeEase",e=>e==="snappy"?"smooth":e==="smooth"?"standard":e==="standard"?"linear":"snappy"),i(I,m),E.$$input=e=>n("fadeMs",Number(e.currentTarget.value)),i(A,v,le),z.$$input=e=>n("blur",Number(e.currentTarget.value)),i(N,r,re),p(e=>{var x=`${v()}ms`,J=`${r()}px`,Q=Ae[m()],ue=y(),de=y(l()),pe=y($()),ce=c,be=c,ve=h,me=c,ge=h,xe=c,fe=y(),ye=c,he=h,we=c,Se=h;return x!==e.e&&P(d,"--shell-sub-fade-ms",e.e=x),J!==e.t&&P(d,"--shell-sub-blur",e.t=J),Q!==e.a&&P(d,"--shell-sub-fade-ease",e.a=Q),e.o=a(_,ue,e.o),e.i=a(f,de,e.i),e.n=a(C,pe,e.n),e.s=a(O,ce,e.s),e.h=a(V,be,e.h),e.r=a(D,ve,e.r),e.d=a(W,me,e.d),e.l=a(q,ge,e.l),e.u=a(U,xe,e.u),e.c=a(I,fe,e.c),e.w=a(j,ye,e.w),e.m=a(A,he,e.m),e.f=a(G,we,e.f),e.y=a(N,Se,e.y),e},{e:void 0,t:void 0,a:void 0,o:void 0,i:void 0,n:void 0,s:void 0,h:void 0,r:void 0,d:void 0,l:void 0,u:void 0,c:void 0,w:void 0,m:void 0,f:void 0,y:void 0}),p(()=>B.value=s()),p(()=>k.value=o()),p(()=>M.value=b()),p(()=>E.value=v()),p(()=>z.value=r()),d})()}};w.parameters={...w.parameters,docs:{...w.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [state, setState] = createStore({
      text: "Prints five topic blocks between timed commands",
      show: true,
      visualDuration: 0.35,
      bounce: 0,
      fadeMs: 320,
      blur: 2,
      fadeEase: "snappy",
      auto: false
    });
    const text = () => state.text;
    const show = () => state.show;
    const visualDuration = () => state.visualDuration;
    const bounce = () => state.bounce;
    const fadeMs = () => state.fadeMs;
    const blur = () => state.blur;
    const fadeEase = () => state.fadeEase;
    const auto = () => state.auto;
    let replayTimer;
    let autoTimer;
    const replay = () => {
      setState("show", false);
      if (replayTimer) clearTimeout(replayTimer);
      replayTimer = setTimeout(() => {
        setState("show", true);
      }, 50);
    };
    const stopAuto = () => {
      if (autoTimer) clearInterval(autoTimer);
      autoTimer = undefined;
      setState("auto", false);
    };
    const toggleAuto = () => {
      if (auto()) {
        stopAuto();
        return;
      }
      setState("auto", true);
      autoTimer = setInterval(replay, 2200);
    };
    onCleanup(() => {
      if (replayTimer) clearTimeout(replayTimer);
      if (autoTimer) clearInterval(autoTimer);
    });
    return <div data-component="shell-submessage-scene" style={{
      display: "grid",
      gap: "20px",
      padding: "20px",
      "max-width": "860px",
      "--shell-sub-fade-ms": \`\${fadeMs()}ms\`,
      "--shell-sub-blur": \`\${blur()}px\`,
      "--shell-sub-fade-ease": ease[fadeEase()]
    }}>
        <style>{shellCss}</style>

        <BasicTool icon="terminal" defaultOpen trigger={<div data-slot="basic-tool-tool-info-structured">
              <div data-slot="basic-tool-tool-info-main">
                <span data-slot="basic-tool-tool-title">Shell</span>
                <SpringSubmessage text={text()} visible={show()} visualDuration={visualDuration()} bounce={bounce()} />
              </div>
            </div>}>
          <div style={{
          "border-radius": "8px",
          border: "1px solid var(--color-divider, #333)",
          background: "var(--color-fill-secondary, #161616)",
          padding: "14px 16px",
          "font-family": "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          "font-size": "18px",
          color: "var(--color-text, #eee)",
          "white-space": "pre-wrap"
        }}>
            {"$ cat <<'TOPIC1'"}
          </div>
        </BasicTool>

        <div style={{
        display: "flex",
        gap: "8px",
        "flex-wrap": "wrap"
      }}>
          <button onClick={replay} style={btn()}>
            Replay entry
          </button>
          <button onClick={() => setState("show", value => !value)} style={btn(show())}>
            {show() ? "Hide subtitle" : "Show subtitle"}
          </button>
          <button onClick={toggleAuto} style={btn(auto())}>
            {auto() ? "Stop auto replay" : "Auto replay"}
          </button>
        </div>

        <div style={{
        display: "grid",
        gap: "10px",
        "border-top": "1px solid var(--color-divider, #333)",
        "padding-top": "14px"
      }}>
          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>subtitle</span>
            <input value={text()} onInput={e => setState("text", e.currentTarget.value)} style={{
            width: "420px",
            "max-width": "100%",
            padding: "6px 8px",
            "border-radius": "6px",
            border: "1px solid var(--color-divider, #333)",
            background: "var(--color-fill-element, #222)",
            color: "var(--color-text, #eee)"
          }} />
          </div>

          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>visualDuration</span>
            <input type="range" min={0.05} max={1.5} step={0.01} value={visualDuration()} onInput={e => setState("visualDuration", Number(e.currentTarget.value))} />
            <span style={sliderValue}>{visualDuration().toFixed(2)}s</span>
          </div>

          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>bounce</span>
            <input type="range" min={0} max={0.5} step={0.01} value={bounce()} onInput={e => setState("bounce", Number(e.currentTarget.value))} />
            <span style={sliderValue}>{bounce().toFixed(2)}</span>
          </div>

          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>fade ease</span>
            <button onClick={() => setState("fadeEase", value => value === "snappy" ? "smooth" : value === "smooth" ? "standard" : value === "standard" ? "linear" : "snappy")} style={btn()}>
              {fadeEase()}
            </button>
          </div>

          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>fade</span>
            <input type="range" min={0} max={1400} step={10} value={fadeMs()} onInput={e => setState("fadeMs", Number(e.currentTarget.value))} />
            <span style={sliderValue}>{fadeMs()}ms</span>
          </div>

          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>blur</span>
            <input type="range" min={0} max={14} step={0.5} value={blur()} onInput={e => setState("blur", Number(e.currentTarget.value))} />
            <span style={sliderValue}>{blur()}px</span>
          </div>
        </div>
      </div>;
  }
}`,...w.parameters?.docs?.source}}};_e(["click","input"]);const Ue=["Playground"];export{w as Playground,Ue as __namedExportsOrder,Ke as default};
