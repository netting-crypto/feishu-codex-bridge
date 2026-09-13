FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev \
  && npm cache clean --force

COPY server-compat.mjs ./
COPY probe.mjs ./

USER node
EXPOSE 10000

CMD ["sh", "-c", "node probe.mjs & exec node server-compat.mjs"]
