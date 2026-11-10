# ─────────────────────────────────────────────────────────────
#  GLM Agent API — API + worker Chromium dans un seul conteneur
#
#  L'API écoute sur $PORT (Render l'injecte).
#  Le worker tourne en tâche de fond dans le même conteneur : il ouvre
#  chat.z.ai, récupère les tâches et renvoie les réponses.
# ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    GLM_PROFILE_DIR=/data/profile

# Dépendances système de Chromium (Playwright installe le reste)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl fonts-liberation tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Dépendances de l'API (aucune)
COPY package.json ./

# 2) Dépendances du worker (playwright + dotenv)
COPY worker/package.json ./worker/package.json
RUN cd worker && npm install --omit=dev --no-audit --no-fund

# 3) Navigateur + ses bibliothèques
RUN cd worker && npx playwright install --with-deps chromium && \
    rm -rf /var/lib/apt/lists/* /root/.npm

# 4) Code
COPY api ./api
COPY server.js ./server.js
COPY worker ./worker

# 5) Utilisateur non root (Chromium tourne mieux ainsi)
RUN mkdir -p /data/profile && chown -R node:node /data /app && \
    printf '#!/bin/sh\nset -e\nexec node server.js\n' > /app/start.sh && chmod +x /app/start.sh

USER node

EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]
