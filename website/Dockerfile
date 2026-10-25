# agent-bridge.pubdoc.dev: build the docs site, serve it with nginx.
# Build with the repository root as the context (docker build -f website/Dockerfile .): the changelog page is
# made from ui/src/lib/changes.ts and the icon comes from web/.
FROM node:22.23.4-alpine AS build
WORKDIR /repo/website
RUN corepack enable
COPY website/package.json website/yarn.lock website/.yarnrc.yml ./
RUN yarn install --immutable
COPY ui/src/lib/changes.ts /repo/ui/src/lib/changes.ts
COPY web/icon.svg /repo/web/icon.svg
COPY website/ ./
RUN yarn build

FROM nginx:1.30.6-alpine
COPY website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/website/src/.vitepress/dist /usr/share/nginx/html
EXPOSE 80
