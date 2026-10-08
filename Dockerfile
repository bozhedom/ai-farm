FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
# npm may skip a failed optional binary download while still reporting success.
# Run only esbuild's locked installer and verify it before caching this layer.
RUN npm ci --ignore-scripts --include=optional \
    && npm rebuild esbuild \
    && node -e "require('esbuild').transformSync('const n: number = 1', { loader: 'ts' })"
COPY . .
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.core.json ./
COPY --chown=node:node core ./core
COPY --chown=node:node worker ./worker
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node db ./db
COPY --chown=node:node prompts ./prompts
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
