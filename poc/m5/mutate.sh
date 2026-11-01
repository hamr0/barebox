#!/bin/bash
# usage: mutate.sh <name>   makes a scratch copy of poc/m5 under /tmp, applies the named mutation, runs the check(s), removes the copy.
set -u
src=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$src/../.." && pwd)
m=$1
d=$(mktemp -d /tmp/bb5-mut-XXXX)
cp -r "$src/." "$d/"
ln -s "$repo/node_modules" "$d/node_modules"
cd "$d"
case $m in
  A-env) # host env passes in (no --clearenv, bwrap started with the host env)
    sed -i "s/env \&\& env.clearenv !== false/false/; s/env \&\& env.spawnClean !== false/false/" src/launcher.js; only=A;;
  A-clearenv-only) # the brief's literal mechanism: --clearenv but bwrap started with the host env
    sed -i "s/env \&\& env.spawnClean !== false/false/" src/launcher.js; only=A;;
  D-noswap) sed -i "s/const r = inValue(str, s, bound);/const r = inValue(str, s, false);/" swap.mjs; only=D,G;;
  E-nohostcheck) sed -i "s/const bound = s.hosts.includes(host);/const bound = true;/" swap.mjs; only=E;;
  F-swap-before-gate)
    python3 - <<'PY'
p=open('src/proxy.js').read()
a="        if (sw) for (const f of sw.found) log({ ev: 'secret', agent, rid, name: f.name, host: url.hostname, swapped: true });\n"
assert a in p; p=p.replace(a,'')
b="      const d = await decideAction(g, action);\n"
assert b in p
p=p.replace(b,"      if (sw) { for (const f of sw.found) log({ ev: 'secret', agent, rid, name: f.name, host: url.hostname, swapped: true }); ctx.headers = sw.headers; }\n"+b,1)
open('src/proxy.js','w').write(p)
PY
    only=F;;
  *) echo "unknown mutation $m"; exit 3;;
esac
diff -ru "$src/src" src | head -20; diff -u "$src/swap.mjs" swap.mjs | head -20
node checks.mjs --only=$only > out.txt 2>&1; e=$?
cut -c1-420 out.txt; echo "mutation=$m exit=$e"
cd /; rm -rf "$d"
