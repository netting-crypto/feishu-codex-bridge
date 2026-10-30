FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY server-compat.mjs diagnostics.mjs auth.mjs ./
COPY probe.mjs verification-cleanup.mjs ./

USER node
EXPOSE 10000

CMD ["sh", "-c", "node probe.mjs & exec node server-compat.mjs"]
