# ABOUTME: Actor container image: Node 22, tsx runtime, no build step (spec §8.1, §11.1).
# ABOUTME: Build context is the repo root so relayer-v2/actor + deployments layout match dev.
FROM node:22-alpine

WORKDIR /app
COPY relayer-v2/actor/package.json ./
RUN npm install --legacy-peer-deps --omit=dev && npm cache clean --force

COPY relayer-v2/actor/tsconfig.json ./
COPY relayer-v2/actor/migrations ./migrations
COPY relayer-v2/actor/src ./src

RUN mkdir -p /state && chown node:node /state
USER node

# Commit the image was built from, surfaced at /health and as an OCI label. Placed last so
# it never invalidates the cached dependency/source layers above.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA

EXPOSE 3001
CMD ["npx", "tsx", "src/main.ts"]
