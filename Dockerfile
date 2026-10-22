# The control page (ui/) is built first; the server and the agent need nothing but node.
FROM node:22.23.4-alpine AS ui
WORKDIR /ui
RUN corepack enable
COPY ui/package.json ui/yarn.lock ui/.yarnrc.yml ./
RUN yarn install --immutable
COPY ui ./
COPY web/relay.js web/qr.js /web/
RUN yarn build

FROM node:22.23.4-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
COPY agent ./agent
COPY --from=ui /ui/dist ./ui/dist
ENV PORT=4300 BRIDGE_DATA=/data NODE_ENV=production
VOLUME /data
EXPOSE 4300
# A deploy starts the new container before stopping the old one; it is sent traffic only once this passes.
HEALTHCHECK --interval=3s --timeout=3s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4300)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/server.mjs"]
