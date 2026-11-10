#!/bin/sh
# start.sh — lance l'API au premier plan et le worker en tâche de fond
set -e

echo "── GLM Agent API ──────────────────────────────"
echo "Port API      : ${PORT:-10000}"
echo "Worker        : ${WORKER_ENABLED:-0} (1 = activé)"
echo "Profil GLM    : ${GLM_PROFILE_DIR:-/data/profile}"
echo "Stockage KV   : $([ -n "$KV_REST_API_URL" ] && echo oui || echo non)"
echo "───────────────────────────────────────────────"

if [ "${WORKER_ENABLED:-0}" = "1" ] && [ -n "$WORKER_TOKEN" ]; then
  echo "Démarrage du worker Chromium en tâche de fond…"
  # Le worker vise l'API locale du même conteneur
  API_BASE="http://127.0.0.1:${PORT:-10000}" \
  WORKER_TOKEN="$WORKER_TOKEN" \
  GLM_PROFILE_DIR="${GLM_PROFILE_DIR:-/data/profile}" \
  HEADLESS="${HEADLESS:-1}" \
  node /app/worker/index.js &
  WORKER_PID=$!
  echo "Worker démarré (pid $WORKER_PID)"
else
  echo "Worker désactivé (WORKER_ENABLED≠1) — l'API seule démarre."
fi

# L'API reste au premier plan : c'est elle que Render surveille
exec node /app/server.js
