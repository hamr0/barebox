#!/usr/bin/env bash
# CI runner setup, shared by ci.yml and publish.yml: the sandbox suites need
# bwrap 0.12.0 (apt's 0.9.0 lacks --overlay-src), socat, curl and openssl,
# and Ubuntu's AppArmor blocks unprivileged user namespaces unless relaxed.
set -euo pipefail

sudo apt-get install -y socat curl openssl python3 meson ninja-build libcap-dev pkg-config
curl -sSfL -o /tmp/bwrap.tar.xz https://github.com/containers/bubblewrap/releases/download/v0.12.0/bubblewrap-0.12.0.tar.xz
echo "9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314  /tmp/bwrap.tar.xz" | sha256sum -c -
tar -xJf /tmp/bwrap.tar.xz -C /tmp
meson setup /tmp/bwrap-build /tmp/bubblewrap-0.12.0 --prefix=/usr -Dman=disabled -Dtests=false -Dselinux=disabled -Dbash_completion=disabled -Dzsh_completion=disabled
ninja -C /tmp/bwrap-build
sudo ninja -C /tmp/bwrap-build install
bwrap --version
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
