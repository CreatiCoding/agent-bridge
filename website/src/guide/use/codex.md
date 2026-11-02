---
description: 새 세션을 Claude Code 대신 맥에 설치된 OpenAI Codex CLI 로 띄우고, 대화 보기·글 보내기·승인 카드로 쓰는 방법과 아직 안 되는 것이에요.
---

# Codex 로 세션 열기

이 가이드를 마치면 맥에 설치된 OpenAI Codex CLI(`codex`)로 세션을 열어 bridge 화면에서 대화를 보고 글을 보낼 수 있어요. 세션은 기본으로 Claude Code 로 뜨고, Codex 는 고를 때만 써요.

## 준비

- 맥에 `codex` 가 설치돼 있고, 터미널에서 `codex` 로 한 번 로그인해 두세요. bridge 는 Codex 의 로그인(`auth.json`)과 설정(`config.toml`)을 읽지 않아요.
- tmux 가 있어야 해요(Codex 세션은 tmux 터미널에서 떠요).
- 에이전트는 시작할 때와 10분마다 `codex --version` 을 물어봐요. 8초 안에 답하면 그 맥에서 Codex 를 고를 수 있어요. 다른 위치의 codex 를 쓰려면 `CLAUDE_BRIDGE_CODEX` 에 경로를 주세요([환경 변수](../../reference/env.md)).

## 열기

1. **새 세션** 화면에서 맥을 고르세요.
2. 그 맥에 Codex 가 있으면 **실행기** 줄이 보여요. **Codex** 를 누르세요. 마지막으로 고른 실행기를 기억해요.
3. 폴더와 첫 메시지를 적고 시작하세요.

Codex 세션은 목록 행과 세션 화면의 설정 칩에 **Codex** 가 붙어요.

## 되는 것

- 대화 보기: Codex 가 남기는 기록(`~/.codex/sessions/…/rollout-*.jsonl`)을 에이전트가 읽어 Claude Code 세션처럼 보여 줘요. 명령 실행은 Bash, 파일 고치기는 Edit, 계획은 할 일 목록처럼 그려요.
- 글 보내기·Esc 로 멈추기·터미널 화면 보기·종료.
- 일하는 중에 보낸 글은 그 턴이 끝난 뒤 전달돼요.
- 명령 승인 질문("Would you like to run the following command?")은 권한 카드가 돼요.
- 새로고침·휴면 깨우기는 같은 Codex 대화를 이어서 열어요(`codex resume`).
- 처음 여는 폴더의 신뢰 질문은 그 세션의 그 폴더에 대해서만 넘겨요. Codex 설정 파일에는 쓰지 않아요.

## 아직 안 되는 것

모델·생각 수준·권한 모드 바꾸기, 복제, 다른 맥·계정·폴더로 옮기기, 압축, 대화 기록 정리, /btw, 스킬 목록, 전부 허용, bridge MCP 도구(할 일 패널·맡기기·첨부), 작성 중 미리보기는 Codex 세션에서 보이지 않고, API 로 불러도 거절돼요. Codex 의 MCP 도구 승인 창은 아직 카드가 되지 않아 터미널 화면에서 답해요.
