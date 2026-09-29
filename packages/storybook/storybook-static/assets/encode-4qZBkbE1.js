function h(e){if(!e)return;let r=2166136261;for(let t=0;t<e.length;t++)r^=e.charCodeAt(t),r=Math.imul(r,16777619);return(r>>>0).toString(36)}export{h as c};
