import{Z as ln,i as t,b as fe,K as r,t as Te,n as an,aa as rn,ab as n}from"./iframe-D288tw9h.js";import{T as me}from"./text-reveal-DqAQuMuw.js";import"./preload-helper-D9Z9MdNV.js";var sn=Te('<div style=display:grid;gap:24px;padding:20px;max-width:700px><div style=display:grid;gap:16px><div><span>text-reveal (mask wipe + slide)</span><div><span>Thinking</span><span></span></div></div><div><span>text-reveal (mask wipe only)</span><div><span>Thinking</span><span></span></div></div></div><div style=display:flex;gap:6px;flex-wrap:wrap></div><div style=display:flex;gap:8px;flex-wrap:wrap><button>Prev</button><button>Next</button><button></button><button></button></div><div style=display:grid;gap:8px;max-width:480px><div style="font-size:11px;color:var(--color-text-weak, #666)">Hybrid (wipe + slide)</div><label style=display:flex;align-items:center;gap:12px><span>edge</span><input type=range min=1 max=40 step=1 style=flex:1><span style=width:60px;text-align:right;font-size:12px>%</span></label><label style=display:flex;align-items:center;gap:12px><span>travel</span><input type=range min=0 max=40 step=1 style=flex:1><span style=width:60px;text-align:right;font-size:12px>px</span></label><div style="font-size:11px;color:var(--color-text-weak, #666);margin-top:8px">Shared</div><label style=display:flex;align-items:center;gap:12px><span>duration</span><input type=range min=100 max=1400 step=10 style=flex:1><span style=width:60px;text-align:right;font-size:12px>ms</span></label><label style=display:flex;align-items:center;gap:12px><span>bounce</span><input type=range min=1 max=2 step=0.01 style=flex:1><span style=width:60px;text-align:right;font-size:12px></span></label><label style=display:flex;align-items:center;gap:12px><span>bounce soft</span><input type=range min=1 max=1.5 step=0.01 style=flex:1><span style=width:60px;text-align:right;font-size:12px></span></label><div style="font-size:11px;color:var(--color-text-weak, #666);margin-top:8px">Wipe only</div><label style=display:flex;align-items:center;gap:12px><span>edge</span><input type=range min=1 max=40 step=1 style=flex:1><span style=width:60px;text-align:right;font-size:12px>%</span></label><label style=display:flex;align-items:center;gap:12px><span>travel</span><input type=range min=0 max=16 step=1 style=flex:1><span style=width:60px;text-align:right;font-size:12px>px</span></label></div><div style="font-size:11px;color:var(--color-text-weak, #888);font-family:monospace">text: <!> · growOnly: '),on=Te("<button>");const xn={title:"UI/TextReveal",id:"components-text-reveal",tags:["autodocs"],parameters:{docs:{description:{component:`### Overview
Playground for the TextReveal text transition component.

**Hybrid** — mask wipe + vertical slide: gradient sweeps AND text moves downward.

**Wipe only** — pure mask wipe: gradient sweeps top-to-bottom, text stays in place.`}}}},g=["Refactor ToolStatusTitle DOM measurement","Remove inline measure nodes","Run typechecks and report changes","Verify reduced-motion behavior","Review diff for animation edge cases","Check keyboard semantics",void 0,"Planning key generation details","Analyzing error handling","Considering edge cases"],x=l=>({padding:"5px 12px","border-radius":"6px",border:l?"1px solid var(--color-accent, #58f)":"1px solid var(--color-divider, #333)",background:l?"var(--color-accent, #58f)":"var(--color-fill-element, #222)",color:"var(--color-text, #eee)",cursor:"pointer","font-size":"12px"}),o={width:"90px","font-size":"12px",color:"var(--color-text-secondary, #a3a3a3)","flex-shrink":"0"},he={padding:"20px 24px","border-radius":"10px",border:"1px solid var(--color-divider, #333)",background:"var(--color-fill-element, #1a1a1a)",display:"grid",gap:"12px"},we={"font-size":"11px","font-family":"monospace",color:"var(--color-text-weak, #666)"},Se={display:"flex","align-items":"center",gap:"8px","font-size":"14px","font-weight":"500","line-height":"20px",color:"var(--text-weak, #aaa)","min-height":"20px",overflow:"visible"},$e={"min-width":"0",overflow:"visible",color:"var(--text-weaker, #888)","font-weight":"400"},y={render:()=>{const[l,i]=ln({index:0,cycling:!1,growOnly:!0,duration:600,bounce:1,bounceSoft:1,hybridTravel:25,hybridEdge:17,edge:17,revealTravel:0}),X=()=>l.index,b=()=>l.cycling,p=()=>l.growOnly,c=()=>l.duration,f=()=>l.bounce,m=()=>l.bounceSoft,h=()=>l.hybridTravel,w=()=>l.hybridEdge,S=()=>l.edge,$=()=>l.revealTravel;let s;const T=()=>g[X()],F=()=>i("index",a=>(a+1)%g.length),_e=()=>i("index",a=>(a-1+g.length)%g.length),ke=()=>{if(b()){s&&clearTimeout(s),s=void 0,i("cycling",!1);return}i("cycling",!0);const a=()=>{F(),s=window.setTimeout(a,700+Math.floor(Math.random()*600))};s=window.setTimeout(a,700+Math.floor(Math.random()*600))};an(()=>{s&&clearTimeout(s)});const H=()=>`cubic-bezier(0.34, ${f()}, 0.64, 1)`,W=()=>`cubic-bezier(0.34, ${m()}, 0.64, 1)`;return(()=>{var a=sn(),D=a.firstChild,_=D.firstChild,K=_.firstChild,U=K.nextSibling,Ce=U.firstChild,V=Ce.nextSibling,Z=_.nextSibling,j=Z.firstChild,q=j.nextSibling,ze=q.firstChild,B=ze.nextSibling,G=D.nextSibling,J=G.nextSibling,k=J.firstChild,C=k.nextSibling,u=C.nextSibling,z=u.nextSibling,Q=J.nextSibling,Oe=Q.firstChild,Y=Oe.nextSibling,ee=Y.firstChild,O=ee.nextSibling,ne=O.nextSibling,Ee=ne.firstChild,te=Y.nextSibling,le=te.firstChild,E=le.nextSibling,ie=E.nextSibling,Ae=ie.firstChild,Ne=te.nextSibling,ae=Ne.nextSibling,re=ae.firstChild,A=re.nextSibling,se=A.nextSibling,Re=se.firstChild,oe=ae.nextSibling,de=oe.firstChild,N=de.nextSibling,Le=N.nextSibling,pe=oe.nextSibling,ge=pe.firstChild,R=ge.nextSibling,Me=R.nextSibling,Ie=pe.nextSibling,xe=Ie.nextSibling,ce=xe.firstChild,L=ce.nextSibling,ue=L.nextSibling,Pe=ue.firstChild,Xe=xe.nextSibling,ve=Xe.firstChild,M=ve.nextSibling,ye=M.nextSibling,Fe=ye.firstChild,I=Q.nextSibling,He=I.firstChild,be=He.nextSibling;return be.nextSibling,t(V,fe(me,{class:"text-14-regular",get text(){return T()},get duration(){return c()},get edge(){return w()},get travel(){return h()},get spring(){return H()},get springSoft(){return W()},get growOnly(){return p()}})),t(B,fe(me,{class:"text-14-regular",get text(){return T()},get duration(){return c()},get edge(){return S()},get travel(){return $()},get spring(){return H()},get springSoft(){return W()},get growOnly(){return p()}})),t(G,()=>g.map((e,v)=>(()=>{var d=on();return d.$$click=()=>i("index",v),t(d,e??"(none)"),r(P=>n(d,x(X()===v),P)),d})())),k.$$click=_e,C.$$click=F,u.$$click=ke,t(u,()=>b()?"Stop cycle":"Auto cycle"),z.$$click=()=>i("growOnly",e=>!e),t(z,()=>p()?"growOnly: on":"growOnly: off"),O.$$input=e=>i("hybridEdge",e.currentTarget.valueAsNumber),t(ne,w,Ee),E.$$input=e=>i("hybridTravel",e.currentTarget.valueAsNumber),t(ie,h,Ae),A.$$input=e=>i("duration",e.currentTarget.valueAsNumber),t(se,c,Re),N.$$input=e=>i("bounce",e.currentTarget.valueAsNumber),t(Le,()=>f().toFixed(2)),R.$$input=e=>i("bounceSoft",e.currentTarget.valueAsNumber),t(Me,()=>m().toFixed(2)),L.$$input=e=>i("edge",e.currentTarget.valueAsNumber),t(ue,S,Pe),M.$$input=e=>i("revealTravel",e.currentTarget.valueAsNumber),t(ye,$,Fe),t(I,()=>T()??"(none)",be),t(I,()=>p()?"on":"off",null),r(e=>{var v=he,d=we,P=Se,We=$e,De=he,Ke=we,Ue=Se,Ve=$e,Ze=x(),je=x(),qe=x(b()),Be=x(p()),Ge=o,Je=o,Qe=o,Ye=o,en=o,nn=o,tn=o;return e.e=n(_,v,e.e),e.t=n(K,d,e.t),e.a=n(U,P,e.a),e.o=n(V,We,e.o),e.i=n(Z,De,e.i),e.n=n(j,Ke,e.n),e.s=n(q,Ue,e.s),e.h=n(B,Ve,e.h),e.r=n(k,Ze,e.r),e.d=n(C,je,e.d),e.l=n(u,qe,e.l),e.u=n(z,Be,e.u),e.c=n(ee,Ge,e.c),e.w=n(le,Je,e.w),e.m=n(re,Qe,e.m),e.f=n(de,Ye,e.f),e.y=n(ge,en,e.y),e.g=n(ce,nn,e.g),e.p=n(ve,tn,e.p),e},{e:void 0,t:void 0,a:void 0,o:void 0,i:void 0,n:void 0,s:void 0,h:void 0,r:void 0,d:void 0,l:void 0,u:void 0,c:void 0,w:void 0,m:void 0,f:void 0,y:void 0,g:void 0,p:void 0}),r(()=>O.value=w()),r(()=>E.value=h()),r(()=>A.value=c()),r(()=>N.value=f()),r(()=>R.value=m()),r(()=>L.value=S()),r(()=>M.value=$()),a})()}};y.parameters={...y.parameters,docs:{...y.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [state, setState] = createStore({
      index: 0,
      cycling: false,
      growOnly: true,
      duration: 600,
      bounce: 1.0,
      bounceSoft: 1.0,
      hybridTravel: 25,
      hybridEdge: 17,
      edge: 17,
      revealTravel: 0
    });
    const index = () => state.index;
    const cycling = () => state.cycling;
    const growOnly = () => state.growOnly;
    const duration = () => state.duration;
    const bounce = () => state.bounce;
    const bounceSoft = () => state.bounceSoft;
    const hybridTravel = () => state.hybridTravel;
    const hybridEdge = () => state.hybridEdge;
    const edge = () => state.edge;
    const revealTravel = () => state.revealTravel;
    let timer: number | undefined;
    const text = () => TEXTS[index()];
    const next = () => setState("index", value => (value + 1) % TEXTS.length);
    const prev = () => setState("index", value => (value - 1 + TEXTS.length) % TEXTS.length);
    const toggleCycle = () => {
      if (cycling()) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        setState("cycling", false);
        return;
      }
      setState("cycling", true);
      const tick = () => {
        next();
        timer = window.setTimeout(tick, 700 + Math.floor(Math.random() * 600));
      };
      timer = window.setTimeout(tick, 700 + Math.floor(Math.random() * 600));
    };
    onCleanup(() => {
      if (timer) clearTimeout(timer);
    });
    const spring = () => \`cubic-bezier(0.34, \${bounce()}, 0.64, 1)\`;
    const springSoft = () => \`cubic-bezier(0.34, \${bounceSoft()}, 0.64, 1)\`;
    return <div style={{
      display: "grid",
      gap: "24px",
      padding: "20px",
      "max-width": "700px"
    }}>
        <div style={{
        display: "grid",
        gap: "16px"
      }}>
          <div style={cardStyle}>
            <span style={cardLabel}>text-reveal (mask wipe + slide)</span>
            <div style={previewRow}>
              <span>Thinking</span>
              <span style={headingSlot}>
                <TextReveal class="text-14-regular" text={text()} duration={duration()} edge={hybridEdge()} travel={hybridTravel()} spring={spring()} springSoft={springSoft()} growOnly={growOnly()} />
              </span>
            </div>
          </div>

          <div style={cardStyle}>
            <span style={cardLabel}>text-reveal (mask wipe only)</span>
            <div style={previewRow}>
              <span>Thinking</span>
              <span style={headingSlot}>
                <TextReveal class="text-14-regular" text={text()} duration={duration()} edge={edge()} travel={revealTravel()} spring={spring()} springSoft={springSoft()} growOnly={growOnly()} />
              </span>
            </div>
          </div>
        </div>

        <div style={{
        display: "flex",
        gap: "6px",
        "flex-wrap": "wrap"
      }}>
          {TEXTS.map((t, i) => <button onClick={() => setState("index", i)} style={btn(index() === i)}>
              {t ?? "(none)"}
            </button>)}
        </div>

        <div style={{
        display: "flex",
        gap: "8px",
        "flex-wrap": "wrap"
      }}>
          <button onClick={prev} style={btn()}>
            Prev
          </button>
          <button onClick={next} style={btn()}>
            Next
          </button>
          <button onClick={toggleCycle} style={btn(cycling())}>
            {cycling() ? "Stop cycle" : "Auto cycle"}
          </button>
          <button onClick={() => setState("growOnly", value => !value)} style={btn(growOnly())}>
            {growOnly() ? "growOnly: on" : "growOnly: off"}
          </button>
        </div>

        <div style={{
        display: "grid",
        gap: "8px",
        "max-width": "480px"
      }}>
          <div style={{
          "font-size": "11px",
          color: "var(--color-text-weak, #666)"
        }}>Hybrid (wipe + slide)</div>

          <label style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>edge</span>
            <input type="range" min="1" max="40" step="1" value={hybridEdge()} onInput={e => setState("hybridEdge", e.currentTarget.valueAsNumber)} style={{
            flex: 1
          }} />
            <span style={{
            width: "60px",
            "text-align": "right",
            "font-size": "12px"
          }}>{hybridEdge()}%</span>
          </label>

          <label style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>travel</span>
            <input type="range" min="0" max="40" step="1" value={hybridTravel()} onInput={e => setState("hybridTravel", e.currentTarget.valueAsNumber)} style={{
            flex: 1
          }} />
            <span style={{
            width: "60px",
            "text-align": "right",
            "font-size": "12px"
          }}>{hybridTravel()}px</span>
          </label>

          <div style={{
          "font-size": "11px",
          color: "var(--color-text-weak, #666)",
          "margin-top": "8px"
        }}>Shared</div>

          <label style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>duration</span>
            <input type="range" min="100" max="1400" step="10" value={duration()} onInput={e => setState("duration", e.currentTarget.valueAsNumber)} style={{
            flex: 1
          }} />
            <span style={{
            width: "60px",
            "text-align": "right",
            "font-size": "12px"
          }}>{duration()}ms</span>
          </label>

          <label style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>bounce</span>
            <input type="range" min="1" max="2" step="0.01" value={bounce()} onInput={e => setState("bounce", e.currentTarget.valueAsNumber)} style={{
            flex: 1
          }} />
            <span style={{
            width: "60px",
            "text-align": "right",
            "font-size": "12px"
          }}>{bounce().toFixed(2)}</span>
          </label>

          <label style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>bounce soft</span>
            <input type="range" min="1" max="1.5" step="0.01" value={bounceSoft()} onInput={e => setState("bounceSoft", e.currentTarget.valueAsNumber)} style={{
            flex: 1
          }} />
            <span style={{
            width: "60px",
            "text-align": "right",
            "font-size": "12px"
          }}>{bounceSoft().toFixed(2)}</span>
          </label>

          <div style={{
          "font-size": "11px",
          color: "var(--color-text-weak, #666)",
          "margin-top": "8px"
        }}>
            Wipe only
          </div>

          <label style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>edge</span>
            <input type="range" min="1" max="40" step="1" value={edge()} onInput={e => setState("edge", e.currentTarget.valueAsNumber)} style={{
            flex: 1
          }} />
            <span style={{
            width: "60px",
            "text-align": "right",
            "font-size": "12px"
          }}>{edge()}%</span>
          </label>

          <label style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>travel</span>
            <input type="range" min="0" max="16" step="1" value={revealTravel()} onInput={e => setState("revealTravel", e.currentTarget.valueAsNumber)} style={{
            flex: 1
          }} />
            <span style={{
            width: "60px",
            "text-align": "right",
            "font-size": "12px"
          }}>{revealTravel()}px</span>
          </label>
        </div>

        <div style={{
        "font-size": "11px",
        color: "var(--color-text-weak, #888)",
        "font-family": "monospace"
      }}>
          text: {text() ?? "(none)"} · growOnly: {growOnly() ? "on" : "off"}
        </div>
      </div>;
  }
}`,...y.parameters?.docs?.source}}};rn(["click","input"]);const cn=["Playground"];export{y as Playground,cn as __namedExportsOrder,xn as default};
