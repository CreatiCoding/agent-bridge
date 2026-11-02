# 바깥 설정 폴더를 Claude 계정으로 연결하기 — 설계

사용자 요청: 한 에이전트에서 세션마다 다른 Claude 설정 폴더(`CLAUDE_CONFIG_DIR`)를 쓰고 싶다. "계정 더하기"(REQ-F-748)는
bridge 가 새로 만든 `~/.claude-bridge/accounts/<id>` 만 다룬다. 이미 있는 다른 설정 폴더(다른 자동화 도구가 쓰는 claude 설정
폴더 등)를 그대로 가리켜, 그 폴더의 대화를 같은 맥의 목록에서 보고 이어서 쓰고 싶다.

## 1. 지금 코드로 되는가 (확인 결과)

`accounts.json` 의 `dir` 은 문자열인지만 본다. 손으로 바깥 경로를 넣으면 세션은 돈다. 그러나 그 폴더를 망가뜨린다.

| 자리 | 지금 동작 | 바깥 폴더에 생기는 일 |
| --- | --- | --- |
| 세션 띄울 때 `prepareAccountDir` | 없는 SHARED 항목(settings.json·CLAUDE.md·skills·hooks…)을 기본 폴더로 심볼릭 링크, `.claude.json` 이 없으면 사본을 씀 | 그 도구가 일부러 비워 둔 설정 자리에 기본 계정 설정이 끼어든다 |
| `sync` | `.claude.json` 을 기본 계정 값으로 덮어 씀 | 그 도구의 MCP 서버 목록이 바뀐다 |
| `logout` | `claude auth logout` | 그 도구의 로그인(키체인 항목)이 지워진다 |
| `remove` | logout 뒤 폴더를 `accounts-removed/` 로 옮김 | 그 도구의 설정 폴더가 사라진다 |
| `login` | `claude auth login` | `.claude.json` 의 `oauthAccount` 와 키체인 항목을 바꾼다 |
| 세션 정리(REQ-F-837 규칙 5) | 모든 계정의 `projects/` 에서 30일 안 쓴 10 MB 넘는 대화 기록을 제안·휴지통 | 그 도구의 대화 기록을 휴지통으로 옮길 수 있다 |
| 화면·API | 바깥 경로로 더하는 길이 없음 | 손으로 `accounts.json` 을 고쳐야 한다 |
| 목록마다 `claude auth status` | 계정마다 실행 | claude 가 그 폴더 `.claude.json` 에 migration 값을 쓰고 `.claude.json.lock`·`backups/` 를 만든다(검토에서 실행해 확인) |
| 대화 기록 정리(`trimlog`) | 기록을 덜어 낸 새 파일로 바꿈 | 그 도구의 대화 파일이 바뀐다 |
| 다른 맥에서 옮겨 올 때 | 받는 맥의 같은 대화 파일을 사본을 남기고 덮어씀 | 그 도구가 이어 쓴 줄이 사라진다 |
| 계정 사이 옮기기 `copySessionState` | `file-history/<conv>` 를 덮어씀 | 그 도구의 되감기 사본이 바뀐다 |
| 세션 없이 대화 내보내기(`export`) | 모든 계정 폴더에서 대화 id 로 찾음 | 서버가 그 도구의 대화를 id 로 받아 갈 수 있다 |

결론: 정식화로는 부족하다. "바깥 폴더 연결"을 따로 둔다.

## 2. 무엇을 하는가

- `accounts.json` 의 항목에 `external: true` 를 둔 계정 = **연결한 폴더**. id·이름·세션 수·로그인 표시는 더한 계정과 같다.
- 연결: 설정 → Claude 계정 → 맥 카드의 "폴더 연결" → 이름과 폴더 경로. IF-211 에 `op: "link"`, `dir`(1,024자까지).
- 원칙: **bridge 는 그 폴더에 직접 쓰지 않는다.** 링크·`.claude.json`·로그인·로그아웃·옮겨 두기·자동 정리 모두 하지 않는다.
  그 폴더에 쓰는 것은 bridge 가 띄운 `claude` 자신뿐이다(대화 기록 `projects/`, 입력 기록, 폴더 신뢰, 되감기 사본 등). 그 도구가
  claude 를 띄워도 똑같이 쓰는 것들이다. 예외: 다른 계정의 세션을 이 계정으로 옮길 때 그 대화의 기록·되감기 사본·폴더 메모리를
  새 파일로 복사한다(REQ-F-751, 같은 이름 메모리 파일은 덮지 않음).
- 연결 해제(`remove`): `accounts.json` 에서 항목만 뺀다. 로그아웃하지 않고 폴더를 옮기거나 지우지 않는다.

## 3. 연결할 때 확인 (에이전트, `linkDirWhy`)

1. 경로: `~` 를 풀고 NFC 로 맞춘 절대 경로, 끝의 `/` 는 뗀다. 1,024자까지.
2. 있는 폴더이고 이 맥 사용자의 것(stat uid = 에이전트 uid).
3. 실제 경로(realpath)가 기본 계정 폴더(CLAUDE_DIR)·이미 있는 계정 폴더·에이전트 폴더(`~/.claude-bridge`)와 그 안쪽·홈 자체가 아니다.
4. `.claude.json` 파일이 그 폴더에 있다. 없으면 첫 실행이 테마 고르기에서 멈추는데 bridge 는 만들지 않으므로 거절한다:
   "그 폴더에 .claude.json 이 없어요. 그 폴더로 claude 를 한 번 띄워 처음 설정을 마친 뒤 연결해 주세요".
5. 계정 수 한도는 더한 계정과 합쳐 10개.

## 4. 로그인(키체인) — 경로 문자열이 곧 열쇠

claude 2.1.316 실행 파일에서 확인: 설정 폴더는 `CLAUDE_CONFIG_DIR` 값을 `normalize("NFC")` 만 하고 풀지 않는다. 키체인 항목은
`"Claude Code-credentials-" + sha256(그 문자열).hex 앞 8자`(`CLAUDE_SECURESTORAGE_CONFIG_DIR` 가 있으면 그 값). 그래서 같은
폴더라도 심볼릭 링크 경로·끝 `/` 가 다르면 다른 로그인이다.

- 연결할 때 후보 문자열 `[적은 그대로(끝 / 뗌), realpath]` 중 키체인 항목이 있는 첫 것(`security find-generic-password -s <이름>`,
  비밀값은 읽지 않음)을 저장한다. 없으면 적은 그대로. 폴더에 `.credentials.json` 이 있으면(파일 로그인) 적은 그대로.
- 연결 뒤 로그인 상태는 §9-2 처럼 읽기만 해서 목록에 보인다. 로그인 안 됨이면 화면이 "그 도구에서 로그인하거나
  터미널에서 `CLAUDE_CONFIG_DIR=<경로> claude auth login`" 을 안내한다. bridge 의 로그인·로그아웃 버튼은 연결한 폴더에 없다
  (`login`·`code`·`logout`·`sync` 는 409 `연결한 폴더는 bridge 가 고치지 않아요…`).
- 한계: 그 도구가 `CLAUDE_SECURESTORAGE_CONFIG_DIR` 로 키체인 이름을 따로 정하면 bridge 세션에서는 로그인 안 됨으로 보인다.

## 5. 대화 목록에 싱크

- 이 맥의 대화 가져오기 목록(`recent`, REQ 가져오기)과 대화 찾기(`findTranscript`)는 이미 모든 계정의 `projects/` 를 훑는다.
  연결하면 그 폴더의 대화가 바로 목록에 뜨고, 가져오면 그 계정으로 `claude --resume` 한다(지금 그대로).
- 목록의 줄에 그 대화의 계정 이름 배지를 단다(기본 계정이 아닐 때).
- 세션 정리의 대화 기록 후보·휴지통(`tidyTranscripts`·`transcriptTrashWhy`)은 연결한 폴더를 보지 않는다(`ownTranscriptRoots`).

## 6. 다른 도구와 동시에 쓸 때

| 경우 | 처리 |
| --- | --- |
| 같은 대화를 그 도구가 지금 쓰는 중 | 가져오기(`adopt`)에서, 그 대화를 잡은 claude 가 살아 있거나(§9-4) 기록이 1분 안에 쓰였으면 거절: "다른 도구가 이 대화를 지금 쓰는 중이에요. 그쪽에서 끝난 뒤(1분 뒤) 다시 가져와 주세요". 기본·더한 계정은 지금처럼 경고 확인만 |
| 가져온 뒤 그 도구가 같은 대화를 다시 resume | 막을 수 없다. 두 claude 가 한 파일에 덧붙여 대화가 갈라진다. 화면 안내·문서에 적는다 |
| 두 claude 가 같은 `.claude.json`·키체인 항목을 씀 | 터미널 두 개로 같은 폴더를 쓰는 것과 같다. bridge 자신은 그 파일에 쓰지 않고 `auth status` 도 부르지 않아 경합을 늘리지 않는다(claude 끼리의 처리는 §9 한계) |
| 그 도구가 폴더를 지우거나 옮김 | 세션 띄울 때 "연결한 설정 폴더가 없어요: <경로>". 목록에는 `missing` 표시, 연결 해제만 할 수 있다 |
| 그 도구가 설정(settings.json·훅·CLAUDE.md·스킬)을 바꿈 | 그 폴더의 것이 그대로 bridge 세션에 적용된다(기본 계정 것이 아님). bridge 의 훅·MCP 는 `--settings`·`--mcp-config` 로 따로 붙어 영향받지 않는다. 연결 확인 창에 적는다 |
| 그 도구가 `.claude.json` 을 지움 | 세션 띄울 때 거절(§3-4 와 같은 문구) |

## 7. 최근 기능과 맞추기

- trust(1.392/1.394): `account` 명령은 `list` 만 free, 나머지는 off. `link` 도 off 라 `enforce` 에서는 거절, `warn` 은 실행·기록.
  봉인 중에는 목록의 `dir` 을 서버로 보내지 않는다(경로는 봉인 대상 글이 아니지만 새 칸을 늘리지 않는다).
- 로컬 화면(1.398): 세션 단위라 따로 바꿀 것이 없다. 연결한 계정의 세션도 그대로 보인다.
- bridge MCP `read_session`(1.401): 이 맥 세션은 `transcriptPath`(계정 폴더 반영)로 읽으므로 그대로 된다.
- 다른 맥으로 옮기기·가벼운 복제: 대화는 서버 사본으로 가므로 바뀌지 않는다. 받는 맥에서 연결한 계정을 고르면 그 폴더에 새 기록이 생긴다.

## 8. 인터페이스

- IF-211 `op` 에 `link`(`name`, `dir`). 서버는 `dir` 을 문자열 1,024자로 잘라 넘긴다. 이름 `폴더 연결`.
- 계정 목록 항목에 `external`(bool), `dir`(`~` 로 줄인 경로, 300자, 봉인 중엔 없음), `missing`(bool).
- `accounts.json` 항목 `{id, name, dir, external: true}`.

## 9. 적대적 검토에서 고친 것

다른 관점(그 폴더 주인·보안)의 검토로 바꾼 것:

1. 경로 비교는 모두 `fs.realpathSync.native`(디스크의 대소문자). `realpathSync` 는 `~/.CLAUDE` 를 그대로 둬 기본 폴더가 "바깥 폴더"로 연결됐고, 디스크 정리의 지키는 폴더 비교도 같은 구멍이 있었다(`keptDirs`·`diskPath`, 기존 버그도 함께 고침. `diskPath` 는 마지막 이름을 따라가지 않고 폴더 목록의 철자만 맞춘다).
2. 연결한 폴더의 로그인은 `claude auth status` 를 부르지 않고 읽기만(`linkedAuth`): 키체인 항목이 있는지(`security find-generic-password -s`, 비밀값은 읽지 않음) 또는 `.credentials.json`, 이메일은 `.claude.json` 의 `oauthAccount` 를 읽는다. 키체인 이름은 claude 처럼 `CLAUDE_SECURESTORAGE_CONFIG_DIR` 를 따른다.
3. `trimlog` 는 연결한 계정 세션에 409. 다른 맥·다른 계정에서 연결한 계정으로 옮길 때, 그 폴더에 같은 대화 파일이 있고 넘어온 기록이 그 파일로 시작하지 않으면(그 도구가 이어 씀) 세션을 내리기 전에 거절한다. `copySessionState` 는 연결한 계정으로는 덮어쓰지 않는다.
4. 가져오기: claude 2.1 이 남기는 `<폴더>/sessions/<pid>.json` 중 `sessionId` 가 그 대화이고 그 pid 가 살아 있으면 거절, 1분 안에 쓰였어도 거절.
5. 저장할 때 `real`(그때의 실제 경로)을 함께 두고, 세션 띄우기·가져오기·옮기기마다 `linkDirWhy` 를 다시 돌리고 `real` 이 같은지 본다(경로의 링크를 나중에 기본 폴더로 바꿔 끼우는 것). 로그인 안 됨이면 띄우지 않는다.
6. 세션 없는 `export` 는 연결한 폴더를 찾지 않는다. 기본 폴더 안쪽 폴더도 거절. 서버는 1,024자 넘는 경로를 자르지 않고 400.
7. 키체인 후보에 끝 `/` 붙은 꼴과 native 실제 경로를 더했다. 연결할 때 그 폴더 `settings.json` 의 `disableAllHooks`·`bypassPermissions`·`apiKeyHelper` 를 알린다.

그대로 두고 적어 둔 것(한계):

- 폴더 신뢰 창은 기본 계정과 같이 bridge 가 자동으로 "예" 한다(`dialog.mjs` folder-trust). claude 가 그 폴더 `.claude.json` 에 그 작업 폴더의 신뢰를 남긴다.
- bridge 세션에 보낸 글이 그 폴더 `history.jsonl` 에 쌓인다(그 도구의 위 화살표 기록에 섞임).
- 두 claude 가 같은 키체인 항목으로 토큰을 갱신할 때의 경합은 claude 의 처리에 맡긴다(잠금이 버전 사이에도 지켜지는지는 확인하지 못함).
- 가져온 뒤 그 도구가 같은 대화를 다시 열면 막지 못한다.
- `link` 는 trust 분류에서 `off`(account 의 `list` 말고 모두): `enforce` 는 거절, `warn` 은 실행·기록. 기본(`off` 모드)에서는 서버가 이미 세션으로 무엇이든 돌릴 수 있어 권한이 새로 늘지 않는다.
- 연결 해제 뒤 다시 연결하면 새 id 가 생긴다.
- 같은 맥 안에서 계정을 오갈 때 받는 계정에 옛 대화 파일이 있으면 그것으로 이어 가는 것(검토가 지적, 모든 계정에 있는 기존 동작)은 이번에 바꾸지 않았다.

## 10. 시험

- 단위: `linkDirWhy`(기본 폴더·에이전트 폴더·홈·없는 폴더·`.claude.json` 없음·같은 폴더 두 번), `keychainService`(알려진 값).
- e2e(`test/e2e-accounts.mjs`): 가짜 바깥 폴더(`.claude.json`·`settings.json`·대화 하나)를 연결 → 목록에 external·로그인 읽힘,
  폴더에 링크가 생기지 않음, `.claude.json`·`settings.json` 바이트 그대로, `recent` 에 그 대화가 그 계정으로 뜸,
  sync·login·logout 409, 그 계정으로 새 세션이 답하고 기록이 그 폴더 `projects/` 에, 세션을 끝낸 뒤 연결 해제 → 폴더·파일 그대로,
  기본 폴더 연결 거절, `.claude.json` 없는 폴더 거절.
