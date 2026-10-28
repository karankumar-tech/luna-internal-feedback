# Luna feedback (pulse): one stateless Node service.
# node:24-slim is multi-arch, so the same file builds for amd64 and arm64 (Graviton):
#   docker buildx build --platform linux/amd64,linux/arm64 -t luna-feedback-pulse .
# The tag tracks the newest 24.x patch; rebuild to pick up Node security releases (24.22.1+).
ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Migrations ship in the image so a Kubernetes Job can run them before a rollout:
#   command: ["node", "scripts/migrate.mjs"]
COPY scripts/migrate.mjs ./scripts/migrate.mjs
COPY supabase/migrations ./supabase/migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
