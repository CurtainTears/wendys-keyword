FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html ./
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data BACKUP_DIR=/app/data/backups
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json server.js LICENSE leaderboard.json ./
COPY server ./server
COPY shared ./shared
COPY seed ./seed
COPY licenses ./licenses
COPY tools/invite.mjs tools/backup.mjs tools/healthcheck.mjs ./tools/
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 CMD ["node", "tools/healthcheck.mjs"]
CMD ["node", "server.js"]
