FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY migrations ./migrations
USER node
EXPOSE 3000
# Migrations run inside server.mjs before it listens, so there is no window in
# which the service is up against a schema that does not exist yet.
CMD ["node", "src/server.mjs"]
