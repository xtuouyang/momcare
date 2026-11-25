FROM node:22-alpine
WORKDIR /app
COPY cloudflare-worker/worker.js ./worker.mjs
COPY server-ai/server.mjs ./server.mjs
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
