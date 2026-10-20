#!/bin/bash
# A: twelve transfers on ONE connection; B: twelve fresh connections back to back. Prints the cold/compose marks of each.
O="$1"; P="$2"
echo "A one connection, 12 transfers:"
curl -s $(for i in $(seq 12); do printf -- '-o /dev/null %s ' "$O$P"; done) -w '%{num_connects} %{time_starttransfer} %header{cf-ray} %header{server-timing}\n' | cut -c1-80
echo "B twelve fresh connections:"
for i in $(seq 12); do curl -s -o /dev/null -w '%{num_connects} %{time_starttransfer} %header{cf-ray} %header{server-timing}\n' "$O$P" | cut -c1-80; done
