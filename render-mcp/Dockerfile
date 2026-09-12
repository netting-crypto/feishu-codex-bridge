FROM node:20-bookworm-slim

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
    pkg-config \
    libsecret-1-0 \
    libsecret-1-dev \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @larksuiteoapi/lark-mcp@0.5.1 \
  && npm cache clean --force

USER node

EXPOSE 10000

CMD ["sh", "-c", "lark-mcp mcp -m streamable --host 0.0.0.0 -p ${PORT:-10000} -l zh"]
