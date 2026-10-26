#!/bin/bash
# mkcerts.sh OUTDIR host... — local CA + one cert per host (openssl).
# CA and leaves carry proper extensions (Python 3.14+ OpenSSL requires them).
# IP hosts get IP SANs, names get DNS SANs.
set -euo pipefail
OUT="$1"; shift
mkdir -p "$OUT"
if [ ! -f "$OUT/ca.pem" ]; then
  openssl genrsa -out "$OUT/ca.key" 2048 2>/dev/null
  printf 'basicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always,issuer\n' > "$OUT/ca.ext"
  openssl req -new -key "$OUT/ca.key" -out "$OUT/ca.csr" \
    -subj "/CN=barebox-m1-ca" 2>/dev/null
  openssl x509 -req -in "$OUT/ca.csr" -signkey "$OUT/ca.key" -sha256 -days 7 \
    -out "$OUT/ca.pem" -extfile "$OUT/ca.ext" 2>/dev/null
  rm -f "$OUT/ca.csr"
fi
for H in "$@"; do
  case "$H" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) SAN="IP:$H" ;;
    *) SAN="DNS:$H" ;;
  esac
  printf 'basicConstraints=CA:false\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$SAN" > "$OUT/$H.ext"
  openssl genrsa -out "$OUT/$H.key" 2048 2>/dev/null
  openssl req -new -key "$OUT/$H.key" -out "$OUT/$H.csr" \
    -subj "/CN=$H" 2>/dev/null
  openssl x509 -req -in "$OUT/$H.csr" -CA "$OUT/ca.pem" -CAkey "$OUT/ca.key" \
    -CAcreateserial -days 7 -sha256 -out "$OUT/$H.pem" \
    -extfile "$OUT/$H.ext" 2>/dev/null
  rm -f "$OUT/$H.csr"
done
echo "certs in $OUT for: $*"
