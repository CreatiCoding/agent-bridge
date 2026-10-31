---
layout: page
title: Agent Bridge
titleTemplate: 맥의 Claude Code 를 폰에서
description: 맥에서 도는 Claude Code 세션을 폰에서 다루고, 맥 사이로 옮기는 셀프호스팅 시스템이에요.
sidebar: false
github: https://github.com/CreatiCoding/agent-bridge
badge: macOS · Claude Code · 셀프호스팅 · AGPL-3.0
headline: [맥의 Claude Code 를, 폰에서, 이어서]
tagline: Agent Bridge 는 맥에서 도는 진짜 Claude Code 세션을 웹에 이어요. 폰으로 대화하고 권한 요청에 답하고, 세션을 맥북에서 아이맥으로 옮겨 이어서 작업해요.
start: { text: 시작하기, link: /guide/getting-started }
arch:
  label: 구조
  name: Agent Bridge
  left: 어디서든
  programs: [폰 브라우저, 다른 맥·PC, 알림·웹 푸시]
  in: 조작
  core: "서버 · 맥의 브라우저 탭 · 127.0.0.1 의 에이전트"
  out: 실행
  right: 내 맥
  ways: [[claude, 진짜 세션], [zeropty, 세션 터미널], [git, 작업 폴더]]
  more: { text: 구성과 연결 자세히 보기, link: /guide/concepts/architecture }
showcase:
  label: 화면
  title: 폰 폭에 먼저 맞춘 조작 화면
  shots:
    - { src: /shots/list.jpg, alt: "세션 목록 화면. 그룹으로 묶인 세션 세 개와 권한 요청을 기다리는 세션 표시", caption: "세션 목록: 그룹, 상태, 응답 대기" }
    - { src: /shots/chat.jpg, alt: "대화 화면. 사용자의 요청, Claude 의 답, 접힌 도구 호출 세 개와 입력창", caption: "대화: 답과 도구 호출이 흘러 들어와요" }
    - { src: /shots/card.jpg, alt: "권한 요청 카드. npm test 실행을 허용할지 세 가지 선택지로 묻는 화면", caption: "결정 카드: 터미널의 확인 창을 버튼으로" }
features:
  - { tag: 맥에 남는 세션, title: 실행도 기록도 내 맥에, body: "서버는 Claude 를 돌리지 않고 대화도 저장하지 않아요. 코드, 자격 증명, 대화 기록은 맥에 남고 서버는 최근 이벤트만 메모리에 둬요.", link: /guide/concepts/architecture }
  - { tag: 열린 포트 없음, title: 터널도 고정 IP 도 없이, body: "맥의 브라우저 탭이 서버와 127.0.0.1 의 에이전트를 이어요. 맥에 포트를 열 필요가 없어요.", link: /guide/concepts/architecture }
  - { tag: 결정 카드, title: 권한 요청에 폰으로 답하기, body: "권한 요청, 질문, 플랜 승인 같은 터미널 확인 창이 카드로 떠요. 지금 화면에 있는 선택지만 눌러요.", link: /guide/concepts/sessions }
  - { tag: 옮기기, title: 맥북에서 아이맥으로, body: "보내는 맥에서 대화와 작업 폴더의 브랜치·커밋을 받아 다른 맥에서 같은 대화를 이어요. 실패하면 원래 자리에 남아요.", link: /guide/concepts/sync }
  - { tag: 끊겨도 그대로, title: 맥이 다시 붙으면 이어서, body: "맥이 잠들거나 탭이 닫혀도 세션은 맥의 터미널에서 계속 돌아요. 다시 연결되면 그 사이의 대화를 이어서 보여 줘요.", link: /guide/concepts/sessions }
  - { tag: 서명된 업데이트, title: 서버를 그대로 믿지 않는 에이전트, body: "에이전트는 운영자 키로 서명된 새 버전만 받아요. 세션에 비밀번호를 걸면 화면, 목록, 알림, 플러그인에서 내용이 가려져요.", link: /guide/concepts/security }
platforms:
  label: 지원 환경
  items:
    - { name: macOS 호스트 }
    - { name: Chrome 연동 페이지 }
    - { name: 폰·PC 브라우저 }
    - { name: zeropty · tmux }
    - { name: Docker 서버 }
    - { name: 헤드리스 연동 모드, badge: 선택 }
  text: 지원 환경 자세히 보기
  link: /guide/requirements
quick:
  label: 맥에서 한 번
  lines:
    - curl -fsSL https://bridge.example.com/install.sh | bash
  text: 시작하기
  link: /guide/getting-started
links:
  label: 더 보기
  items:
    - { text: 소개, link: /guide/introduction }
    - { text: 서버 올리기, link: /guide/operate/self-host }
    - { text: 레퍼런스, link: /reference/ }
    - { text: 변경 기록, link: /changelog }
    - { text: GitHub, link: https://github.com/CreatiCoding/agent-bridge }
    - { text: llms.txt, link: /llms.txt }
---

<Home />
