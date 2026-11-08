# 예시 로컬 어댑터

예시 익스텐션의 `note.save`(쓰기)·`note.list`(읽기)를 세션의 맥에서 실행한다(REQ-F-893). 맥의 주인이 직접 설치한다. 에이전트의 서명된 파일은 건드리지 않는다.

```sh
mkdir -p ~/.claude-bridge/adapters
cp -R extensions/example/adapter ~/.claude-bridge/adapters/example
chmod -R go-w ~/.claude-bridge/adapters/example
```

- 폴더나 `adapter.json` 을 다른 사용자가 고칠 수 있으면 에이전트가 쓰지 않는다.
- 부를 때마다 이 폴더에서 `command` 를 한 번 실행한다. 요청은 stdin 의 JSON, 결과는 stdout 의 JSON 이다. 0 이 아닌 종료 코드는 실패(stderr 끝 줄이 이유)다.
- 고친 내용은 다음 호출부터 바로 쓴다(에이전트를 다시 시작하지 않아도 된다).
