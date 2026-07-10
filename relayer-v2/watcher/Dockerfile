# ABOUTME: Watcher container image: Ponder app, no secrets baked or passed (D2/S1).
# ABOUTME: Publishes indexed views to the `indexed` schema for the actor (spec §5).
FROM node:22-alpine

WORKDIR /app
COPY relayer-v2/watcher/package.json ./
RUN npm install --legacy-peer-deps --omit=dev && npm cache clean --force

COPY relayer-v2/watcher/tsconfig.json relayer-v2/watcher/ponder.config.ts relayer-v2/watcher/ponder.schema.ts ./
COPY relayer-v2/watcher/abis ./abis
COPY relayer-v2/watcher/src ./src

# `ponder start` runs codegen at boot and writes ponder-env.d.ts + generated/ into WORKDIR.
# COPY leaves /app owned by root; give the runtime user ownership so those writes succeed
# (no secrets involved — D2).
RUN chown -R node:node /app
USER node
EXPOSE 42069
CMD ["sh", "-c", "npx ponder start --schema ${DATABASE_SCHEMA:-watcher} --views-schema ${VIEWS_SCHEMA:-indexed}"]
