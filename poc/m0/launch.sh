#!/usr/bin/env bash
# M0 POC launcher: bwrap walls + socat bridge. No overlay (that's M4).
# Usage: launch.sh <runtime> <agent> <proj-fixture> <cmd...>
set -u
RUNTIME=$1; AGENT=$2; PROJ=$3; shift 3
SOCK=$RUNTIME/socks/$AGENT.sock
mkdir -p "$RUNTIME/socks"

ARGS=(
  --unshare-pid --unshare-uts --unshare-ipc
  --die-with-parent
  --proc /proc --dev /dev --tmpfs /tmp
  --ro-bind /usr /usr
  --symlink usr/lib64 /lib64
  --ro-bind /etc /etc
)
# RED-TEAM HOOKS (throwaway POC only): SBX_BREAK=nonet|nolock|rw.
# Default path is unchanged: full isolation.
[ "${SBX_BREAK:-}" = nonet ] || ARGS+=(--unshare-net)
if [ "${SBX_BREAK:-}" = rw ]; then
  ARGS+=(--bind "$PROJ" "$PROJ" --bind "$HOME" "$HOME")
else
  ARGS+=(--ro-bind "$PROJ" "$PROJ" --ro-bind "$HOME" "$HOME")
fi
# Locked drawers: mask each one that exists on this host.
if [ "${SBX_BREAK:-}" != nolock ]; then
  for p in "$HOME/.ssh" "$HOME/secrets" "$HOME/.mozilla" "$HOME/.config/chromium" "$HOME/.gnupg"; do
    [ -d "$p" ] && ARGS+=(--tmpfs "$p")
  done
fi
ARGS+=(
  --dir /run
  --tmpfs /run/sbx
  --bind "$SOCK" /run/sbx/agent.sock
  --setenv HOME "$HOME"
  --setenv PATH /usr/bin:/bin:/usr/sbin
  --setenv HTTP_PROXY http://127.0.0.1:3128
  --setenv HTTPS_PROXY http://127.0.0.1:3128
  --setenv http_proxy http://127.0.0.1:3128
  --setenv https_proxy http://127.0.0.1:3128
)
exec bwrap "${ARGS[@]}" \
  /usr/bin/bash -c 'ip link set lo up 2>/dev/null; socat TCP-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/sbx/agent.sock & exec "$@"' bash "$@"
