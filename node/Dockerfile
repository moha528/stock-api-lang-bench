# syntax=docker/dockerfile:1

# --- Étape 1 : dépendances de production uniquement -------------------------
FROM node:24-trixie-slim AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 # uWebSockets.js embarque ~15 binaires (tous OS/arch/ABI) : on ne garde que celui de cette image.
 && keep="uws_linux_$(node -p process.arch)_$(node -p process.versions.modules).node" \
 && find node_modules/uWebSockets.js -name 'uws_*.node' ! -name "$keep" -delete \
 && rm -f node_modules/uWebSockets.js/*.d.ts node_modules/uWebSockets.js/*.md \
 && node -e "require('uWebSockets.js')"

# --- Étape 2 : runtime minimal (le binaire uWS exige glibc >= 2.38 : Debian 13, pas d'alpine/musl) ---
FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production \
    # 512 Mo pour le conteneur : tas old-gen plafonné à 384 Mo (marge pour le RSS natif),
    # young-gen élargie pour réduire la fréquence des scavenges sur les allocations JSON par requête.
    NODE_OPTIONS="--max-old-space-size=384 --max-semi-space-size=16"
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
EXPOSE 8080
# L'entrypoint distroless est déjà `node` (exec form : reçoit SIGTERM directement).
CMD ["src/index.js"]
