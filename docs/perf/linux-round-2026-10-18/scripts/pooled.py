import json, sys, os, random, statistics as st
R='/home/user/bench/runs'
def load(run):
    rows={}
    def add(k,v): rows.setdefault(k,[]).append(v)
    a=json.load(open(f'{R}/{run}/app-start/result.json'))
    for o in a['observations']:
        if o['status']=='valid': add('start '+o['case']['startMode'].replace('-application-state',''),o['durationMs'])
    w=json.load(open(f'{R}/{run}/session-switch-walk/result.json'))
    for o in w['observations']:
        c=o['case']
        if o['status']!='valid' or c['workload']!='list-walk': continue
        kind='long' if 'long' in c['destinationSessionId'] else ('8MiB' if c['transcriptBytes']==8388608 else '1MiB')
        add(f"{'first' if c['sessionState']=='cold' else 'return'} {kind}",o['durationMs'])
    r=w['resources']
    add('rss launch',r['baselineIdleAverageRssMiB']); add('rss walk',r['endingIdleAverageRssMiB'])
    return rows
def pool(runs):
    out={}
    for run in runs:
        for k,v in load(run).items(): out.setdefault(k,[]).extend(v)
    return out
def mw(x,y):
    try:
        from scipy.stats import mannwhitneyu
        return mannwhitneyu(x,y).pvalue
    except Exception: return float('nan')
def boot(x,y,n=2000):
    rnd=random.Random(1); rs=[]
    for _ in range(n):
        rs.append(st.median(rnd.choices(x,k=len(x)))/st.median(rnd.choices(y,k=len(y))))
    rs.sort(); return rs[int(.025*n)], rs[int(.975*n)]
controls=sys.argv[1].split(','); cands=sys.argv[2:]
C=pool(controls)
order=['start new','start initialized','first 1MiB','first 8MiB','first long','return 1MiB','return 8MiB','return long','rss launch','rss walk']
for cand in cands:
    X=pool(cand.split(','))
    print(f'== {cand} vs pooled {",".join(controls)}')
    for k in order:
        c,x=C.get(k,[]),X.get(k,[])
        if not c or not x: continue
        mc,mx=st.median(c),st.median(x); lo,hi=boot(c,x) if len(c)>1 and len(x)>1 else (float('nan'),)*2
        p=mw(c,x); flag=''
        if lo>1.0 and p<0.05: flag='CANDIDATE FASTER/LOWER'
        elif hi<1.0 and p<0.05: flag='candidate slower/higher'
        print(f'  {k:15s} ctrl {mc:9.1f} (n={len(c):3d})  cand {mx:9.1f} (n={len(x):3d})  ctrl/cand {mc/mx:5.3f} CI [{lo:.3f},{hi:.3f}] p={p:.3f} {flag}')
