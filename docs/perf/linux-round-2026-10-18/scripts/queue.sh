#!/usr/bin/env bash
# usage: queue.sh <item>...   item = control:<name> | <bench-branch-suffix>:full | <bench-branch-suffix>:renderer
set -u
CONTROL=/home/user/bench/apps/control-24980400
BUILD=/home/user/bench/wt/build
status=/home/user/bench/queue-status.log
for item in "$@"; do
  name=${item%%:*}; mode=${item#*:}
  if [ "$name" = control ]; then
    run=control-$mode
    echo "$(date -u +%T) RUN $run" >> $status
    /home/user/bench/bench-run.sh "$run" "$CONTROL/claxedo" >> $status 2>&1
    continue
  fi
  app=/home/user/bench/apps/$name
  echo "$(date -u +%T) BUILD $name ($mode)" >> $status
  git -C $BUILD checkout -q --detach "bench/$name" || { echo "checkout failed $name" >> $status; continue; }
  if [ "$mode" = renderer ]; then
    /home/user/bench/repack.sh $BUILD "$app" --renderer-only $CONTROL > /home/user/bench/logs/build-$name.log 2>&1
  else
    /home/user/bench/repack.sh $BUILD "$app" > /home/user/bench/logs/build-$name.log 2>&1
  fi
  [ $? -eq 0 ] || { echo "$(date -u +%T) BUILD FAILED $name" >> $status; continue; }
  sleep 20
  echo "$(date -u +%T) RUN $name" >> $status
  /home/user/bench/bench-run.sh "$name" "$app/claxedo" >> $status 2>&1
  rm -rf "$app"
done
echo "$(date -u +%T) QUEUE DONE" >> $status
