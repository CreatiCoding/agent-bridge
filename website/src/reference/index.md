---
description: Agent Bridge 레퍼런스가 다루는 것과 모든 레퍼런스 페이지의 목록, 가이드·변경 기록·전체 명세로 가는 길을 안내해요.
---

# 레퍼런스 안내

레퍼런스는 Agent Bridge 의 명령, 옵션, 환경 변수, 경로, 상태, 한도를 빠짐없이 찾아보는 곳이에요. 설치와 사용법, 예시는 [가이드](/guide/introduction)를 보세요.

이 페이지는 SPEC 판 1.309 기준이에요.

레퍼런스의 모든 페이지는 같은 판의 명세와 코드에서 옮겨 적었어요. 각 페이지 맨 위에 기준 판이 있어요. 판마다 바뀐 점은 [변경 기록](/changelog)에 있어요.

## 맥 (에이전트)

| 페이지 | 다루는 것 |
|---|---|
| [설치 스크립트와 에이전트 명령](/reference/agent-cli) | `install.sh` 인자, `agent.mjs` 의 명령(`service`, `link`, `doctor`, `awake`)과 옵션, launchd 서비스, `agent.json` 키 |
| [점검 항목](/reference/checks) | 에이전트 점검 항목 전체, 세션 시작을 막는 항목, 점검이 도는 때, 기기 화면의 진단 항목, 자동 복구 |
| [맥의 파일과 경로](/reference/files) | `~/.claude-bridge/` 와 그 밖에 에이전트가 쓰는 파일, 권한과 크기, 서버 데이터 폴더 배치 |

## 서버

| 페이지 | 다루는 것 |
|---|---|
| [환경 변수](/reference/env) | 서버 환경 변수(기본값, 필수 여부)와 에이전트·서명 스크립트 환경 변수 |
| [주소와 HTTP API](/reference/routes) | 사용자 페이지 주소, `/api/health`, 로그인한 사용자의 API 묶음, 요청 규칙, 속도 제한, 에이전트의 로컬 경로 |
| [플러그인 API](/reference/plugin-api) | 플러그인 정의 모양, 설정 칸, 실행 인스턴스, 호스트 호출, 설정 API |

## 화면과 동작

| 페이지 | 다루는 것 |
|---|---|
| [세션 상태와 카드](/reference/states) | 목록의 상태 표시, 세션·호스트 상태 전이, 카드 종류와 답하는 법, 스스로 넘기는 확인 창, 붙잡은 글 |
| [한도와 시간](/reference/limits) | 명령 대기 시간, 주기, 알림 시점, 개수·크기 한도, 로그인·잠금, 보관 기간, 공개 데모 한도 |
| [용어집](/reference/glossary) | 문서와 화면에서 쓰는 용어와 약어의 뜻 |

## 다른 곳으로

| 찾는 것 | 가는 곳 |
|---|---|
| 처음 설치하고 첫 세션 열기 | [시작하기](/guide/getting-started) |
| 구조와 동작 원리 | [구성과 연결](/guide/concepts/architecture), [세션의 일생](/guide/concepts/sessions) |
| 한 가지 일을 끝내는 순서 | [폰에서 세션 다루기](/guide/use/sessions) 등 사용 가이드 |
| 서버 올리기와 운영 | [서버 올리기](/guide/operate/self-host), [문제 해결](/guide/operate/troubleshooting) |
| 판마다 바뀐 점 | [변경 기록](/changelog) |

## 전체 명세

레퍼런스는 사용자와 운영자가 찾는 값만 골라 담았어요. 요청·응답의 모든 필드, 오류 코드, 상태 기계, 수용 기준까지 담은 전체 명세는 저장소의 [`docs/SPEC.md`](https://github.com/CreatiCoding/agent-bridge/blob/main/docs/SPEC.md)에 있어요. 레퍼런스와 명세가 다르면 명세의 같은 판이 기준이에요.
