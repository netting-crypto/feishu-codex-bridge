FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev \
  && npm cache clean --force

COPY server-compat.mjs ./

USER node
EXPOSE 10000

CMD ["node", "server-compat.mjs"]
