#!/bin/sh
# Arranque en producción (Docker). SESSION_SECRET y TOKEN_KEY se generan una vez y se guardan en el volumen /data.
set -e
cd /app
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
if [ ! -f /data/secrets.env ]; then
  S=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  T=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  printf 'SESSION_SECRET=%s\nTOKEN_KEY=%s\n' "$S" "$T" > /data/secrets.env
  chmod 600 /data/secrets.env
fi
set -a
. /data/secrets.env
set +a
while [ -z "$TIKTOK_CLIENT_KEY" ] || [ -z "$TIKTOK_CLIENT_SECRET" ]; do
  echo "Faltan TIKTOK_CLIENT_KEY y TIKTOK_CLIENT_SECRET en el entorno del proyecto reelnext (hPanel > VPS > Docker)."
  sleep 300
done
exec node server.mjs
