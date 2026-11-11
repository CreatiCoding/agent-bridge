# The control page (ui/) is built with node; the server is one Go binary (standard library only). The image that
# runs has no node: the agent's files (agent/*.mjs) are only served to the Macs, never run here.
# The three base images, overridable for a registry mirror (docker build --build-arg NODE_IMAGE=…). The defaults are
# the images this file has always used.
ARG NODE_IMAGE=node:22.23.4-alpine
ARG GO_IMAGE=golang:1.27.3-alpine
ARG RUN_IMAGE=alpine:3.22
FROM ${NODE_IMAGE} AS ui
WORKDIR /ui
RUN corepack enable
COPY ui/package.json ui/yarn.lock ui/.yarnrc.yml ./
RUN yarn install --immutable
COPY ui ./
COPY web/relay.js web/qr.js /web/
# The published extension types: the type check holds the page's bridge object against them.
COPY extensions/agent-bridge-ext.d.ts /extensions/
RUN yarn build

# The Mac builds for `local --full` (REQ-F-901): the same Go and web screen as above, by scripts/build-localfull.sh.
# The maintainer's Mac builds this very stage before signing (scripts/sign-agent.mjs), so both make the same bytes.
FROM ${GO_IMAGE} AS localfull
WORKDIR /src
COPY server ./server
COPY web ./web
COPY package.json ./
COPY scripts/build-localfull.sh ./scripts/
COPY --from=ui /ui/dist ./ui/dist
RUN sh scripts/build-localfull.sh /src /src/ui/dist /out
FROM scratch AS localfull-out
COPY --from=localfull /out /

# gofmt, go vet and the tests must pass, or the image is not built.
FROM ${GO_IMAGE} AS server
WORKDIR /src
COPY server ./server
COPY agent ./agent
COPY web ./web
# The example extension: a test loads it as it is.
COPY extensions ./extensions
COPY package.json ./
COPY test/fixtures/tidy-groups.json ./test/fixtures/tidy-groups.json
WORKDIR /src/server
RUN test -z "$(gofmt -l .)" || { echo "gofmt 가 고칠 파일:"; gofmt -l .; exit 1; }
RUN go vet ./...
RUN CGO_ENABLED=0 go test ./...
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bridge-server .
# The Mac builds must be the ones signed in server/localfull.json, or the image is not made: a build that came out
# different from the signed one is never handed out (REQ-F-901). A fork that does not sign its own sets
# --build-arg LOCALFULL_CHECK=0, and its server then hands out no Mac build.
ARG LOCALFULL_CHECK=1
COPY --from=localfull /out /out/localfull
RUN if [ "$LOCALFULL_CHECK" = "1" ]; then /out/bridge-server localfull-verify /out/localfull /src/server/localfull.json; else rm -rf /out/localfull && mkdir /out/localfull; fi

FROM ${RUN_IMAGE}
WORKDIR /app
RUN apk add --no-cache ca-certificates tzdata
COPY package.json ./
COPY server/quality.json ./server/quality.json
# The signed documents of the Mac builds in localfull/ (REQ-F-901): read at start, only matching builds are handed out.
COPY server/localfull.json ./server/localfull.json
# /skills/version 의 code 는 server/skills.go 의 내용까지 해시한다(codeHash). 바이너리만 두면 빈 값으로 계산된다.
COPY server/skills.go ./server/skills.go
COPY web ./web
COPY agent ./agent
COPY --from=ui /ui/dist ./ui/dist
COPY --from=server /out/bridge-server ./bridge-server
COPY --from=server /out/localfull ./localfull
ENV PORT=4300 BRIDGE_DATA=/data
VOLUME /data
EXPOSE 4300
# A deploy starts the new container before stopping the old one; it is sent traffic only once this passes.
HEALTHCHECK --interval=3s --timeout=3s --start-period=30s --retries=3 CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-4300}/api/health" || exit 1
CMD ["/app/bridge-server"]
