import json,sys
for path in sys.argv[1:]:
    d=json.load(open(path))
    reqs=[r for r in d["requests"] if r["start"]>=0]
    reqs.sort(key=lambda r:r["start"])
    depth={}
    for i,r in enumerate(reqs):
        before=[depth[j] for j,o in enumerate(reqs) if j!=i and o["end"]<=r["start"]+5 and j in depth]
        depth[i]=1+max([0]+before)
    print(f"== {path}: {len(reqs)} API requests, {max(depth.values()) if depth else 0} dependent wave(s), rows at {d['rowsAt']} ms, delay {d['delayMs']} ms")
    for i,r in enumerate(reqs):
        print(f"{r['start']:7.0f}→{r['end']:<7.0f} w{depth[i]}  {r['url']}")
