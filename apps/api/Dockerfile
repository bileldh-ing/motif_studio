# MOTIF API — production image (build from repo root: docker build -f apps/api/Dockerfile .)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/project-schema/package.json packages/project-schema/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @motif/api... --prod --ignore-scripts

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY packages/project-schema packages/project-schema
COPY apps/api/src apps/api/src
COPY apps/api/migrations apps/api/migrations
COPY apps/api/package.json apps/api/
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
