---
description: 새 서버 컨테이너를 먼저 띄우고 옛 서버가 상태와 요청을 넘겨주게 해서, 요청 실패 없이 Agent Bridge 서버를 새 버전으로 올리는 절차예요.
---

# 끊기지 않는 배포

이 가이드를 마치면 서버를 새 버전으로 바꾸는 동안에도 요청이 실패하지 않고, 맥에서 돌던 세션도 그대로 이어져요. 서버를 처음 올리는 절차는 [서버 올리기](/guide/operate/self-host)를 보세요.

## 시작하기 전에

- [서버 올리기](/guide/operate/self-host)를 마쳐 서버가 `/data` 볼륨으로 돌고 있어야 해요.
- 배포 도구가 **새 컨테이너를 먼저 띄우고 옛 컨테이너를 나중에 멈춰야** 해요. Docker Swarm 의 `update_config.order: start-first` 가 그 방식이에요.
- 두 컨테이너가 **같은 `/data` 볼륨**을 마운트하고, 서로의 비루프백 IPv4 주소의 `PORT`(기본 4300)에 HTTP 로 닿아야 해요.
- 에이전트 파일을 고쳤다면 먼저 서명해 두세요. [에이전트 서명 키](/guide/operate/signing)를 보세요.

옛 서버가 새 서버에 상태를 넘겨주는 흐름은 [구성과 연결](/guide/concepts/architecture#서버를-바꿀-때)을 보세요.

## 1. 배포 설정에 start-first 넣기

Docker Swarm 이라면 스택 파일에 이렇게 두세요. 환경 변수는 [서버 올리기](/guide/operate/self-host)와 같아요.

```yaml [docker-compose.yml]
services:
  bridge:
    image: claude-bridge:TAG
    volumes:
      - bridge-data:/data
    environment:
      BRIDGE_ORIGIN: https://bridge.example.com
      GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID}
      GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET}
      BRIDGE_ADMIN_LOGINS: YOUR_LOGIN
    networks:
      - proxy
    stop_grace_period: 10s
    deploy:
      replicas: 1
      update_config:
        parallelism: 1
        order: start-first
      placement:
        constraints:
          - node.hostname == NODE_NAME
volumes:
  bridge-data:
networks:
  proxy:
    external: true
```

자리표시는 이래요.

- `TAG`: 이번에 빌드한 이미지 태그예요.
- `NODE_NAME`: 서버를 돌릴 Swarm 노드 이름이에요. 이름 있는 볼륨은 노드마다 따로 생겨요. 새 컨테이너가 다른 노드에 뜨면 같은 `/data` 를 보지 못해 넘겨주기가 되지 않아요.
- `proxy`: HTTPS 리버스 프록시가 붙어 있는 네트워크예요. 프록시는 이 네트워크에서 서비스의 `4300` 포트로 보내요.

Dokploy 처럼 Swarm 으로 배포하는 도구를 쓰면, 그 도구의 업데이트 설정에서 같은 값(`start-first`)을 고르세요.

::: warning 주의
- `replicas` 는 1 로 두세요. 넘겨주기 밖에서 두 서버가 같은 데이터 폴더를 동시에 쓰면 세션 정보(meta)가 어긋나요.
- `stop_grace_period` 를 8초보다 짧게 두지 마세요. 옛 서버는 정지 신호를 받은 뒤 8초 동안 요청을 새 서버로 넘기고 끝나요. Swarm 기본값은 10초예요.
- 이미지의 `HEALTHCHECK` 는 3초마다 `/api/health` 를 불러요(시작 유예 30초, 3번 실패하면 비정상). 이 검사를 끄면 새 컨테이너가 준비되기 전에 트래픽을 받을 수 있어요.
:::

## 2. 새 버전 배포하기

1. 새 이미지를 빌드하세요.

   ```sh [터미널]
   docker build -t claude-bridge:TAG .
   ```

2. 처음이면 스택을 올리고, 그 뒤로는 이미지만 바꾸세요.

   ```sh [터미널]
   docker stack deploy -c docker-compose.yml bridge
   docker service update --image claude-bridge:TAG bridge_bridge
   ```

3. 두 컨테이너의 로그를 함께 보세요.

   ```sh [터미널]
   docker service logs -f bridge_bridge
   ```

## 확인하기

배포하는 동안 다른 터미널에서 health 를 계속 불러 보세요.

```sh [터미널]
while true; do curl -s SITE/api/health; echo; sleep 1; done
```

`instance` 값이 한 번 바뀌고, 그 사이에 실패한 줄이 없으면 성공이에요. `SITE` 는 서버 주소예요(예: `https://bridge.example.com`).

::: info 잠긴 세션은 비밀번호를 다시 물어요
새 서버는 옛 서버에서 연결된 맥 목록만 넘겨받고, 잠긴 세션을 연 열쇠는 넘겨받지 않아요. 그래서 배포 뒤에는 잠긴 세션을 다시 열 때 비밀번호를 한 번 더 물어요. 고장이 아니에요.
:::

로그에서는 이 순서가 보여야 해요.

| 서버 | 로그 |
|---|---|
| 새 | `handover: asking the running server (<id>) for the state` |
| 옛 | `handover: a newer server (<id>) asked for the state; finishing and writing it` |
| 새 | `handover: the running server wrote its state and stopped writing` |
| 옛 | `handover: the new server is up at <주소>:<포트>; passing requests on to it` |

배포 뒤에는 운영 탭의 **사용자별 기기** 에서 맥들이 다시 "연결됨" 인지 보세요. 에이전트 파일이 바뀐 배포라면, 세션이 쉰 뒤 맥들이 "최신" 으로 바뀌어요.

## 문제가 생기면

- **`handover: no answer from the running server; starting from what is on disk`**: 옛 서버가 20초 안에 답하지 않았어요. 새 서버는 디스크의 상태로 시작해요. 옛 서버가 살아 있는지, 같은 볼륨을 보는지 확인하세요.
- **`handover: the new server did not come up; taking the state back`**: 옛 서버가 새 서버의 주소에 닿지 못했어요. 두 컨테이너가 같은 네트워크에 있는지, `PORT` 가 같은지 보세요. 옛 서버는 다시 혼자 돌아요.
- **넘겨주기 로그가 하나도 없어요**: 돌고 있는 서버가 없거나(처음 켤 때, 옛 서버를 먼저 끄는 배포), 두 컨테이너가 다른 볼륨을 봐요. `docker compose up` 의 재생성처럼 옛 것을 먼저 끄는 방식은 디스크에서 바로 시작해서, 그 사이 요청이 실패할 수 있어요.
- **배포 중 502 가 나요**: 옛 서버가 새 서버로 넘기다 연결에 실패하면 `Retry-After: 1` 과 함께 502 를 돌려줘요. 네트워크 설정을 확인하세요.

## 다음 단계

- [에이전트 서명 키](/guide/operate/signing): 맥들이 새 에이전트를 받게 해요.
- [접근 관리와 운영 화면](/guide/operate/admin): 배포 뒤 맥 상태를 확인해요.
- [구성과 연결](/guide/concepts/architecture#서버를-바꿀-때): 배포 중 옛 서버가 새 서버에 상태와 요청을 넘겨주는 흐름을 알 수 있어요.
