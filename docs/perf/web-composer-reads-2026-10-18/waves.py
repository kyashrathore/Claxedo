import json,sys
for path in sys.argv[1:]:
    d=json.load(open(path))
    reqs=[r for r in d["requests"] if r["start"]>=0]
    reqs.sort(key=lambda r:r["start"])
    depth={}
    for i,r in enumerate(reqs):
        before=[depth[j] for j,o in enumerate(reqs) if j!=i and o["end"]<=r["start"]+5 and j in depth]
        depth[i]=1+max([0]+before)
    chip=d["chipAt"]
    upto=[i for i,r in enumerate(reqs) if r["end"]<=chip]
    print(f"== {path}: chip names model at {chip} ms; {len(upto)} requests ended before it, {max([depth[i] for i in upto] or [0])} waves, {sum(max(0,reqs[i]["bytes"]) for i in upto)} wire B, {sum(max(0,reqs[i].get("decoded",0)) for i in upto)} decoded B; {len(reqs)} total requests, {sum(max(0,r['bytes']) for r in reqs)} bytes")
    for e in d["chipLog"]: print(f"   chip {e['t']:6d} {e['text']!r}")
    for i,r in enumerate(reqs):
        mark = "*" if r["end"]<=chip else " "
        print(f"{mark}{r['start']:7.0f}→{r['end']:<7.0f} w{depth[i]} {r["bytes"]:>6}B {r.get("decoded",-1):>6}D {r['origin'][:14]:14} {r['url'][:120]}")
