// 변경 기록 (REQ-F-744): a changelog in the Keep a Changelog shape, shown to everyone in Settings → 변경 기록.
// One release per SPEC version (the docs/SPEC.md 판 the commit carries), newest first. A commit that changes what
// people see or what the system does adds its release here in the same commit (CLAUDE.md §1).
// `commit` is filled in later (a commit cannot name its own hash); leave it out for the release being written.

export type ChangeKind = 'added' | 'changed' | 'fixed' | 'removed' | 'security'
export type ChangeScope = 'ui' | 'server' | 'agent'

export interface Change {
  kind: ChangeKind
  scope: ChangeScope[]
  text: string
  /** SPEC ids (REQ-…, IF-…, ERR-…). */
  refs?: string[]
}

export interface Release {
  /** The SPEC version, e.g. '1.141'. */
  version: string
  /** YYYY-MM-DD */
  date: string
  /** Short hash of the commit that carries this version. */
  commit?: string
  changes: Change[]
}

export const CHANGES: Release[] = [
  {
    version: '1.415',
    date: '2026-11-04',
    changes: [
      {
        kind: 'fixed',
        scope: ['server', 'ui'],
        text: '봉인(trust seal on)한 맥의 세션 제목과 도구 줄이 짝지은 기기에서도 🔒 로만 보이던 것: 서버가 짧은 칸에서 봉인 조각을 자르지 않고 통째로 넘겨 화면이 열어 보여 줌. 너무 큰 조각의 제목은 🔒 <폴더 이름>',
        refs: ['REQ-S-099', 'REQ-S-095'],
      },
    ],
  },
  {
    version: '1.414',
    date: '2026-11-04',
    commit: '0589a7f',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server', 'ui'],
        text: 'Codex 세션의 샌드박스(read-only·workspace-write)·승인(on-request·never)을 새 세션·맥의 대화 이어 가기에서 고름. workspace-write 면 샌드박스 안 네트워크 허용도. 고르지 않으면 지금처럼 codex 기본값. danger-full-access 는 없음',
        refs: ['REQ-F-854', 'REQ-F-851', 'REQ-F-853'],
      },
      {
        kind: 'added',
        scope: ['agent', 'server', 'ui'],
        text: 'Codex 세션 설정에서 샌드박스·승인을 바꾸면 다음에 다시 열 때(codex resume) 그 모드로 뜸',
        refs: ['REQ-F-854'],
      },
      {
        kind: 'added',
        scope: ['server'],
        text: 'bridge.yaml features.codexSandboxes·codexApprovals·codexNetwork 로 고를 수 있는 Codex 모드를 제한. 밖의 값은 403',
        refs: ['REQ-F-854', 'REQ-F-812'],
      },
      {
        kind: 'security',
        scope: ['agent', 'ui'],
        text: 'Codex 모드(codexMode)를 new·adopt 서명 항목에 넣어 서버가 바꿔 넣지 못함. 서명 맥의 다시 열기는 맥의 기록만 씀. trust 판 8',
        refs: ['REQ-F-854', 'REQ-S-091'],
      },
    ],
  },
  {
    version: '1.413',
    date: '2026-11-04',
    commit: 'fedba92',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server', 'ui'],
        text: '이 맥의 대화 이어 가기에 맥의 Codex 대화(~/.codex/sessions)도 보이고, 고르면 그 폴더에서 codex resume 으로 이어 엶. 목록 줄마다 실행기(Claude Code / Codex) 배지',
        refs: ['REQ-F-853', 'REQ-F-048'],
      },
      {
        kind: 'security',
        scope: ['agent', 'ui'],
        text: 'Codex 대화 가져오기는 고른 폴더가 rollout 첫 줄의 폴더와 같을 때만, 그 대화를 연 codex 가 살아 있거나 1분 안에 쓰였으면 거절. 실행기도 서명·봉인 조각에 넣음. trust 판 7',
        refs: ['REQ-F-853', 'REQ-S-091', 'REQ-S-095'],
      },
    ],
  },
  {
    version: '1.412',
    date: '2026-11-04',
    commit: '07694a5',
    changes: [
      {
        kind: 'security',
        scope: ['agent'],
        text: '서명 필수 맥의 대화 가져오기에서, 서명 밖인 세션 id 를 새 세션·열기와 같이 검사(경로 꼴이거나 이미 열린 세션 id 면 거절). trust 판 6',
        refs: ['REQ-F-048', 'REQ-S-092'],
      },
      {
        kind: 'security',
        scope: ['agent', 'ui'],
        text: '봉인 맥의 대화 목록은 항목마다 대화 id·폴더·제목을 한 조각으로 봉인하고, 페이지는 그 조각의 값으로만 보이고 서명함(서버가 제목과 다른 대화를 끼울 수 없음)',
        refs: ['REQ-S-095'],
      },
    ],
  },
  {
    version: '1.411',
    date: '2026-11-04',
    commit: '760ff9e',
    changes: [
      {
        kind: 'security',
        scope: ['agent'],
        text: '세션의 sudo 가 명령에 보이지 않으면(s\\udo, su""do, $x, 스크립트 안) 관리자 권한이 열려 있어도 비밀번호를 다시 물음. 전에는 전부 허용에서 위험 호출 판별을 지나 열린 5분 동안 묻지 않고 root 로 돌 수 있었음',
        refs: ['REQ-F-764', 'REQ-F-759'],
      },
      {
        kind: 'security',
        scope: ['agent'],
        text: '전부 허용이어도 셸 시작 파일(.zshrc, .bashrc, .profile …)에 쓰는 호출은 물음',
        refs: ['REQ-F-759'],
      },
      {
        kind: 'security',
        scope: ['server'],
        text: '무중단 배포의 넘김 머리글을 비밀값과 상수 시간으로 비교',
        refs: ['REQ-F-064'],
      },
    ],
  },
  {
    version: '1.410',
    date: '2026-11-04',
    commit: 'cf1f6f5',
    changes: [
      {
        kind: 'fixed',
        scope: ['server'],
        text: '무중단 배포 넘겨주기가 늘 실패하던 것. 새 서버가 root 로 쓴 요청 파일(0600)을 node 로 도는 옛 서버가 읽지 못해, 배포마다 디스크에서 시작하고 옛 서버의 처리 중 요청이 502 로 끊겼다. root 로 쓰는 넘겨주기 파일을 데이터 폴더 주인에게 넘김',
        refs: ['REQ-F-063'],
      },
      {
        kind: 'added',
        scope: ['server'],
        text: '서비스 API 세션 열기(POST /api/service/sessions)의 key: 같은 key 로 열린 닫히지 않은 서비스 세션이 있으면 새로 열지 않고 그 id 를 reused:true 로 돌려줌. 답을 잃은 뒤 다시 불러도 세션이 둘 생기지 않음',
        refs: ['REQ-F-799', 'IF-249'],
      },
    ],
  },
  {
    version: '1.409',
    date: '2026-11-04',
    commit: '64acc56',
    changes: [
      {
        kind: 'fixed',
        scope: ['agent'],
        text: 'Codex 세션에 보낸 슬래시 명령(/status, /mcp …)이 답 없이 끝나던 것. Codex 는 결과를 터미널 화면에만 그려, 에이전트가 화면에서 읽어 대화에 알림으로 옮김',
        refs: ['REQ-F-852'],
      },
      {
        kind: 'fixed',
        scope: ['agent'],
        text: 'Codex 의 /diff 페이저나 /model 선택 창이 열린 채 남아 그 뒤에 보낸 글을 먹던 것. 내용을 알림으로 옮기고 닫으며, 글을 보내기 전에도 열린 창을 먼저 닫음. 슬래시 명령의 Enter 는 400 ms 뒤로(Codex 의 120 ms 붙여넣기 판정을 넘게)',
        refs: ['REQ-F-852'],
      },
    ],
  },
  {
    version: '1.408',
    date: '2026-11-04',
    commit: '1a555b8',
    changes: [
      {
        kind: 'security',
        scope: ['agent', 'ui'],
        text: '서명 필수(enforce) 맥에서도 "맥의 대화 이어 가기"를 쓴다. 가져오기를 끔에서 서명 명령으로 바꾸고 페이지가 대화 id·폴더를 서명. 맥은 대화 기록에 적힌 폴더가 서명한 폴더와 같을 때만 열고, 서버가 넣은 시스템 프롬프트·라우팅은 버림. TRUST_VERSION 5',
        refs: ['REQ-F-048', 'REQ-S-091', 'REQ-S-093'],
      },
      {
        kind: 'fixed',
        scope: ['agent'],
        text: '기본 폴더(~/.claude)의 대화도 터미널·다른 도구가 지금 쓰는 중이면(실행 중 pid 또는 1분 안에 쓰인 기록) 가져오지 않음. 같은 기록에 claude 둘이 쓰던 것을 막음',
        refs: ['REQ-F-048', 'REQ-F-848'],
      },
    ],
  },
  {
    version: '1.407',
    commit: 'ff22b4d',
    date: '2026-11-04',
    changes: [
      {
        kind: 'added',
        scope: ['server', 'ui'],
        text: 'bridge.yaml 의 features.reports: false 로 문제 제보를 끔. 새 제보·영상 올리기는 403, 서비스센터 버튼과 ⋯ 메뉴의 "문제 제보"를 숨김. 보낸 제보 보기·지우기와 운영 화면의 제보는 그대로',
        refs: ['REQ-F-812'],
      },
    ],
  },
  {
    version: '1.406',
    date: '2026-11-03',
    commit: '4c3d04b',
    changes: [
      {
        kind: 'fixed',
        scope: ['server'],
        text: '턴이 끝난 직후 서버가 다시 뜨면 맡긴 세션·서비스 세션이 답을 잃고 계속 working 으로 보였다(자동 수정 서버가 4시간 제한까지 멈춤). 이제 메모리에 답이 없고 세션이 쉬는 중이거나 닫혔으면 맥에 마지막 답을 물어 done 으로 본다. 세션마다 30초에 한 번만 묻는다',
        refs: ['REQ-F-760', 'IF-250'],
      },
    ],
  },
  {
    version: '1.405',
    date: '2026-11-03',
    commit: '9b4d29c',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server', 'ui'],
        text: '세션 실행기: 세션마다 띄우는 CLI 를 기록한다(없으면 Claude Code). 맥이 hello 의 runners 로 쓸 수 있는 실행기를 알리고, 새 세션 화면은 둘 이상일 때만 "실행기"를 묻는다(기본 Claude Code, 마지막 선택 기억).',
        refs: ['REQ-F-851', 'IF-016', 'IF-088', 'ERR-347'],
      },
      {
        kind: 'added',
        scope: ['agent'],
        text: 'OpenAI Codex CLI 실행기: codex --version 이 8 s 안에 답하는 맥에서 tmux 로 codex 를 띄우고, ~/.codex/sessions 의 rollout 만 읽어 Claude Code 트랜스크립트 모양 사본으로 바꿔 대화를 보인다. 턴은 rollout 의 task_started·task_complete, 명령 승인 질문은 권한 카드, 다시 열기는 codex resume. codex 의 로그인·설정 파일은 읽지 않는다.',
        refs: ['REQ-F-851', 'IF-097', 'IF-098'],
      },
      {
        kind: 'changed',
        scope: ['server', 'ui'],
        text: '실행기가 못 하는 기능(모델·effort·권한 모드, 복제, 옮기기, 압축, 기록 정리, /btw, 스킬, 전부 허용)은 화면에서 숨기고 서버가 409 로 거절한다. 목록 행 배지·설정 칩에 실행기 이름. trust 의 new 서명 항목에 runner(TRUST_VERSION 4).',
        refs: ['REQ-F-851', 'REQ-F-824', 'ERR-348', 'ERR-349', 'REQ-S-092'],
      },
    ],
  },
  {
    version: '1.404',
    date: '2026-11-03',
    commit: '9af2b79',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: '익스텐션이 답 하나를 통째로 다룬다: around 만 받는 액션 message.render({sid, seq, text, quiet, isLast} → {text} 또는 {hide: true, reason?}). 접힌 답은 "🤫 조용히 접은 답" 한 줄과 펼치기로 남고, 바뀐 답은 "<이름> 이 바꿈 · 원문 보기"를 단다. 카드·경고·오류·사람 말은 훅에 오지 않는다',
        refs: ['REQ-F-850', 'REQ-F-822'],
      },
      {
        kind: 'added',
        scope: ['server', 'ui'],
        text: 'extension.yaml 의 messages.quiet(끝 글자 suffix, 정규식 아님, 5개)로 끝나는 Claude 의 답은 조용한 답: 접혀 보이고 새 답 점·알림 웹훅(session.done 에 quiet: true)·Slack 스레드 글을 내지 않는다. 턴의 마지막 답 단위이며 같은 턴에 경고·카드가 있거나 API 오류 답이면 조용하지 않다',
        refs: ['REQ-F-850', 'REQ-F-825', 'REQ-F-817'],
      },
      {
        kind: 'security',
        scope: ['server', 'agent'],
        text: '조용한 답 규칙은 사람이 직접 동의했을 때만 쓴다(extensionConsent: false 면 안 씀). 봉인하는 맥은 서버가 고른 규칙을 받지 않고 맥 터미널의 trust quiet add|rm 으로 정한 끝 글자만 판정해 평문 표지 bridgeQuiet: "mac" 을 붙인다(서버가 봉인된 답의 끝을 맞춰 보지 못하게)',
        refs: ['REQ-F-850', 'REQ-S-095'],
      },
    ],
  },
  {
    version: '1.403',
    date: '2026-11-03',
    commit: '351a309',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server'],
        text: '실시간 연결(SSE)이 막힌 네트워크(긴 응답·스트리밍을 끊거나 버퍼링하는 프록시)에서 조작 화면이 멈추지 않는다: 첫 메시지 10초·조용함 50초로 막힘을 보고, 서버가 일반 요청에 답할 때만 세어 2번이면 GET /api/classic/poll 커서 조회(같은 delta 메시지, 보일 때 20초 기다리는 조회·숨었을 때 30초)로 받는다. 화면 오른쪽 위에 작은 "폴링" 표시',
        refs: ['REQ-F-849', 'IF-271', 'IF-015'],
      },
      {
        kind: 'added',
        scope: ['ui', 'server'],
        text: '연동 탭도 서버 명령 스트림이 막히면 GET /api/bridge/poll 로 받는다(다시 붙으면 rehello, 시도 번호로 늦은 옛 요청 거절). 둘 다 60초 뒤부터(실패마다 2배, 최대 15분) 같은 주소의 탐침(probe=1)이 따로따로 오면 SSE 로 돌아간다',
        refs: ['REQ-F-849', 'IF-272', 'IF-075'],
      },
      {
        kind: 'security',
        scope: ['server'],
        text: '조회는 스트림과 같은 인증·자리 한도(사람당 32)를 쓰고, 너무 잦은 조회(429)·늦은 요청(410)·사람당 새 자리 분당 30개·밀린 양 1 MiB(연동 4 MiB)·5분(연동 30초) 만료로 서버 부하를 묶는다',
        refs: ['REQ-F-849', 'IF-271', 'IF-272'],
      },
    ],
  },
  {
    version: '1.402',
    date: '2026-11-02',
    commit: '2b8fd33',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server', 'ui'],
        text: '설정 → Claude 계정의 "폴더 연결": 다른 도구가 쓰는 Claude Code 설정 폴더(CLAUDE_CONFIG_DIR)를 그대로 계정으로 연결한다. 그 폴더의 대화가 "이 맥의 대화 이어 가기" 에 계정 이름과 함께 보이고, 그 계정으로 새 세션을 시작하거나 가져와 이어 쓴다. 이 맥 사용자의 폴더이고 .claude.json 이 있어야 하며, 기본 설정 폴더(대소문자만 다른 경로 포함)·에이전트 폴더·홈은 거절',
        refs: ['REQ-F-848', 'IF-211'],
      },
      {
        kind: 'security',
        scope: ['agent'],
        text: '연결한 폴더는 bridge 가 고치지 않는다: 링크·.claude.json 사본 없음, 로그인 상태는 claude 를 부르지 않고 키체인 항목·.claude.json 을 읽기만, 로그인·로그아웃·공유 설정 맞추기·대화 기록 정리는 거절, 연결 해제는 목록에서만 빼고, 세션·디스크 정리 후보에서 빠진다. 그 대화를 잡은 claude 가 살아 있거나 1분 안에 쓰였으면 가져오지 않고, 그 도구가 이어 쓴 대화 파일은 옮겨 오며 덮어쓰지 않는다',
        refs: ['REQ-F-848', 'REQ-F-837'],
      },
      {
        kind: 'fixed',
        scope: ['agent'],
        text: '디스크 정리가 지키는 폴더(기본 설정 폴더·에이전트 폴더)를 대소문자만 바꾼 경로(~/.CLAUDE)로 고르면 지키지 못하던 것: 경로를 디스크의 대소문자로 비교한다',
        refs: ['REQ-F-848'],
      },
    ],
  },
  {
    version: '1.401',
    date: '2026-11-02',
    commit: '0d313d0',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server', 'ui'],
        text: '세션이 맥의 파일을 대화에 첨부한다(bridge MCP `attach`): 최대 4 MB, 홈·임시 폴더·세션 폴더 안만, 키·비밀 파일은 거절. 대화에 첨부 카드가 생겨 그림은 미리 보고 그 밖은 받는다. 맥에는 복사본이 30일 남는다',
        refs: ['REQ-F-846', 'IF-269', 'IF-270'],
      },
      {
        kind: 'added',
        scope: ['agent', 'server'],
        text: '세션이 같은 사람의 다른 세션 최근 대화를 읽는다(bridge MCP `read_session`): id·이름으로 지정, 최대 100개. 같은 맥 세션은 맥이 직접 읽어 서버를 거치지 않고, 다른 맥은 서버를 거친다',
        refs: ['REQ-F-847', 'IF-270'],
      },
      {
        kind: 'security',
        scope: ['agent'],
        text: '서버를 믿지 않는 맥: 첨부는 봉인할 때 한 조각으로 봉인하고, 봉인·enforce 맥은 다른 세션 읽기를 서버에 묻지 않으며, 봉인 맥은 다른 맥에 대화를 보내지 않는다',
        refs: ['REQ-S-095'],
      },
    ],
  },
  {
    version: '1.400',
    date: '2026-11-02',
    commit: '70e4f90',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: '휴면 세션을 주소·링크로 열 때 이 브라우저에 남은 옛 목록(휴면 전 값)으로 판단해 깨우지 않던 것. 이제 서버 상태를 받은 뒤에 깨울지 정한다',
        refs: ['REQ-F-562'],
      },
      {
        kind: 'fixed',
        scope: ['server'],
        text: '휴면 세션을 깨우는 몇 초(claude 다시 띄우는 중) 사이 누른 종료·제거가 "세션을 옮기는 중입니다"로 거절되던 것. 이제 깨우기가 끝날 때까지 기다렸다 한다',
        refs: ['REQ-F-501'],
      },
    ],
  },
  {
    version: '1.399',
    date: '2026-11-02',
    commit: 'af48e7c',
    changes: [
      {
        kind: 'fixed',
        scope: ['agent'],
        text: '세션 정리: 홈(~) 같은 위쪽 폴더에서 연 세션이 하나 있으면 모든 작업 폴더를 "열린 세션이 쓰는 중"으로 봐 폴더 제안이 늘 0개였다. 이제 세션 폴더가 그 폴더이거나 그 안쪽일 때만 쓰는 중으로 본다(정리 실행·자동 정리 직전 재확인도 같게)',
        refs: ['REQ-F-837'],
      },
    ],
  },
  {
    version: '1.398',
    date: '2026-11-02',
    commit: '71a91b8',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server'],
        text: '서버가 내려가도 쓰는 로컬 화면: 맥 터미널의 `node ~/.claude-bridge/agent.mjs local` 이 일회용 링크를 열고, 에이전트가 http://127.0.0.1:<port>/local/ 에서 그 맥의 세션 목록·터미널 화면을 보여 주며 글·키·Esc·권한 답을 보낸다. 서버·연동 탭 없이 동작한다',
        refs: ['REQ-F-843', 'IF-267'],
      },
      {
        kind: 'added',
        scope: ['agent', 'server'],
        text: '로컬 화면 묶음: 에이전트에 들어 있는 묶음(builtin)으로 처음부터 오프라인으로 뜨고, 연동 중 서버가 더 새 관리자 서명 묶음을 보내면 서명·해시를 확인해 staged → install 로 바꾼다. 깨지면 builtin 으로 되돌리고, 터미널에서 `local on|off|ota on|off|status|rollback|reset`. agent.json `localUi` 기본 켜짐',
        refs: ['REQ-F-844', 'REQ-F-845', 'IF-268'],
      },
      {
        kind: 'security',
        scope: ['agent'],
        text: '로컬 화면 입구는 127.0.0.1·자기 포트의 Host·Origin 만, 일회용 입장권(5분·한 번)과 로컬 토큰으로만 열리고 연동 키로는 열리지 않는다. 묶음은 관리자 키 서명과 늘기만 하는 순번이 맞을 때만 쓴다',
        refs: ['REQ-S-096', 'REQ-S-097'],
      },
      {
        kind: 'security',
        scope: ['agent'],
        text: '맥 터미널 전용 파일·명령(trust·localui 폴더, agent.mjs trust|local)은 묻지 않는 전부 허용에서도 묻는다. 에이전트가 agent.json 을 쓸 때 trustSeal 을 덮어써 봉인을 끌 수 있던 것을 고침. TRUST_VERSION 3',
        refs: ['REQ-S-098', 'REQ-S-094'],
      },
    ],
  },
  {
    version: '1.397',
    date: '2026-11-02',
    commit: '347927b',
    changes: [
      {
        kind: 'fixed',
        scope: ['server'],
        text: '휴면 세션을 열자마자 보낸 글이 "세션을 옮기는 중입니다" 로 거절되던 것: claude 를 다시 띄우는 동안 온 글·명령은 다 뜰 때까지(최대 90초) 기다렸다 보낸다',
        refs: ['REQ-F-501'],
      },
    ],
  },
  {
    version: '1.396',
    date: '2026-11-02',
    commit: '3f3bc43',
    changes: [
      {
        kind: 'changed',
        scope: ['server', 'agent', 'ui'],
        text: '휴면은 claude 를 내린다: 세션 메뉴·밀기·목록·세션 정리의 "휴면"이 세션 정리의 손으로 내리기와 같은 길로 claude 를 끄고 숨긴다. 작업 폴더·대화 기록은 남고 끝난 세션이 아니라 7일 뒤에도 지워지지 않는다. 열거나 꺼내 쓰거나 글을 보내면 같은 대화로 다시 띄운다. 이미 내려간 세션은 표시만 바꾼다',
        refs: ['REQ-F-501', 'REQ-F-562', 'REQ-F-570', 'IF-067', 'IF-263'],
      },
      {
        kind: 'changed',
        scope: ['server'],
        text: '작업 중·확인 창 대기·맡긴 일 대기·맡겨진 세션·자동 대응 중·바뀌는 중·옮기는 중이면 휴면을 거절하고 이유를 알린다(409, 예: "작업 중이라 지금은 휴면할 수 없어요")',
        refs: ['REQ-F-501', 'REQ-F-570'],
      },
      {
        kind: 'changed',
        scope: ['server', 'agent'],
        text: '가벼운 복제가 끝나면 원본도 claude 를 내려 휴면에 둔다. 막히면 예전처럼 표시만 둔다',
        refs: ['REQ-F-496', 'REQ-F-501'],
      },
    ],
  },
  {
    version: '1.395',
    date: '2026-11-02',
    commit: '06201e2',
    changes: [
      {
        kind: 'changed',
        scope: ['agent', 'server'],
        text: '즐겨찾기한 세션은 세션 정리의 자동 단계에서 빠진다: 오래 쉬어도 claude 를 내리지 않고(예고도 없음), 휴면으로 두지 않으며, 휴면·끝내기 제안에도 오르지 않는다. 끝난 뒤에도 그 작업 폴더는 폴더 휴지통(자동·제안)에 오르지 않는다. 손으로 하는 종료·휴지통은 그대로',
        refs: ['REQ-F-782', 'REQ-F-835', 'REQ-F-836', 'REQ-F-837', 'IF-263'],
      },
      {
        kind: 'changed',
        scope: ['server', 'agent'],
        text: '예고가 걸린 세션을 즐겨찾기하면 예고가 바로 지워진다. 즐겨찾기를 풀면 원래 규칙으로 돌아가 다시 하루 앞서 예고하고, 쉰 기간은 마지막 사람 입력부터 센다',
        refs: ['REQ-F-782', 'REQ-F-835', 'IF-067'],
      },
      {
        kind: 'added',
        scope: ['ui'],
        text: '세션 정리 화면의 내릴 세션 목록 아래에 "즐겨찾기라 정리하지 않음 · 세션 n개", 세션 메뉴의 즐겨찾기 힌트에 "자동 정리 안 함"',
        refs: ['REQ-F-839', 'REQ-F-782'],
      },
    ],
  },
  {
    version: '1.394',
    date: '2026-11-02',
    commit: '901d4f8',
    changes: [
      {
        kind: 'security',
        scope: ['ui', 'server', 'agent'],
        text: '서버를 믿지 않는 맥의 내용 봉인(선택, 기본 꺼짐): 맥 터미널에서 `trust seal on` 을 켜면 대화·터미널 화면·권한 카드·알림 글을 짝지은 기기만 풀 수 있게 봉인해 내보낸다. 서버·짝짓지 않은 브라우저에는 🔒 로 보이고, 푸시·Slack·웹훅에는 내용이 가지 않는다. 그림은 평문',
        refs: ['REQ-S-095'],
      },
      {
        kind: 'changed',
        scope: ['ui'],
        text: '설정 → 화면·알림 "맥 짝짓기" 에 봉인 여부를 보이고, 봉인하지 않는 맥에는 켜는 법을 안내한다. 봉인하는 맥에 보내는 글도 봉인한 뒤 서명한다',
        refs: ['REQ-S-095', 'REQ-S-089'],
      },
      {
        kind: 'changed',
        scope: ['agent'],
        text: '봉인 중에는 대화 파일 내보내기(다른 맥으로 옮기기)를 서버로 보내지 않고, trust 판(TRUST_VERSION)을 2로 올려 봉인 없는 빌드로 되돌리지 못하게 한다',
        refs: ['REQ-S-095', 'REQ-S-094'],
      },
    ],
  },
  {
    version: '1.393',
    date: '2026-11-02',
    commit: '20715a2',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: '설정 첫 화면 "기기": 기기마다 카드 한 장에 연결 상태, CPU·메모리·디스크 사용률 막대(디스크 85% 노랑·95% 빨강), 배터리, 세션 정리 방식(자동·제안만·끔)과 내릴 세션·제안 수. 카드를 누르면 그 기기의 디스크 관리·세션 정리가 펼쳐진 채 열린다(/disk?host=<id>). 운영자는 다른 사용자 기기를 같은 카드로 아래에 따로 본다(세션 정리 숫자는 주인이 허용했을 때만)',
        refs: ['REQ-F-842', 'REQ-F-803', 'REQ-F-804', 'REQ-F-807'],
      },
      {
        kind: 'changed',
        scope: ['ui'],
        text: '설정 탭을 다시 묶음: 기기 · 세션(새 세션 기본값·모델 라우팅·기본 프롬프트) · 계정 · 화면·알림 · 플러그인 · 음성 · 운영 · 더 보기(다른 화면·도움말·버전·변경 기록). /settings/prompt·/settings/changes·/settings/launch·/disk 주소는 그대로 열린다',
        refs: ['REQ-F-711', 'REQ-F-744'],
      },
    ],
  },
  {
    version: '1.392',
    date: '2026-11-02',
    commit: 'ac9c8f1',
    changes: [
      {
        kind: 'security',
        scope: ['ui', 'server', 'agent'],
        text: '서버를 믿지 않는 맥(선택, 기본 꺼짐): 맥 터미널에서 `trust mode enforce` 로 켜고 `trust pair` 로 이 기기와 짝지으면, 그 맥은 짝지은 기기가 서명한 명령만 실행한다. 서버가 털려도 그 맥에 글을 보내거나 세션을 열고 닫거나 권한에 답할 수 없다. 짝짓기는 기기 화면의 6자리 숫자를 맥 터미널에 입력해 확인한다',
        refs: ['REQ-S-089', 'REQ-S-090', 'REQ-S-091', 'REQ-S-092', 'REQ-S-093'],
      },
      {
        kind: 'added',
        scope: ['ui'],
        text: '설정 → 이 기기에 "맥 짝짓기" 카드: 맥마다 모드·지문·짝지은 기기 목록을 보고, 짝짓고, 해제한다. 짝지은 기기에서는 받아쓰기의 "전송" 자동 보내기와 확장을 끈다',
        refs: ['REQ-S-090', 'REQ-S-091'],
      },
      {
        kind: 'changed',
        scope: ['agent'],
        text: '서명 필수인 맥에서는 sudo 비밀번호 넘기기, 다른 맥에 맡기기, 영상·파일 올리기, 서버 미리보기, 세션 가져오기·옮기기, 세션 정리의 자동 내리기가 꺼지고, trust 를 낮추는 업데이트는 받지 않는다',
        refs: ['REQ-S-093', 'REQ-S-094'],
      },
    ],
  },
  {
    version: '1.391',
    date: '2026-11-02',
    commit: '9c107d1',
    changes: [
      {
        kind: 'fixed',
        scope: ['server'],
        text: '맡긴 세션이 "CI 기다리는 중"처럼 중간 보고를 하고 백그라운드 작업을 기다리면 자동으로 닫히던 것. 백그라운드 작업이 남아 있으면 닫지 않고 "백그라운드 작업이 남아 아직 닫지 않았어요"라고 알리며, 작업이 끝나 다시 답하면 그때 닫는다',
        refs: ['REQ-F-760'],
      },
      {
        kind: 'fixed',
        scope: ['server'],
        text: '백그라운드 작업 목록에 백그라운드로 넘어간 MCP 도구 호출과 예약된 깨우기(ScheduleWakeup)도 들어간다',
        refs: ['REQ-F-760', 'REQ-F-519'],
      },
    ],
  },
  {
    version: '1.390',
    date: '2026-11-02',
    commit: '6022566',
    changes: [
      {
        kind: 'changed',
        scope: ['server', 'agent'],
        text: '다른 맥에 맡긴 세션은 답을 전하면 저절로 닫히고 목록에서도 바로 빠진다. 닫힌 뒤에도 delegate_status 로 마지막 답을 볼 수 있고, 3개 한도도 바로 풀린다',
        refs: ['REQ-F-760', 'REQ-F-742'],
      },
      {
        kind: 'added',
        scope: ['server', 'agent'],
        text: '맡긴 세션이 닫히면 bridge 가 그 일 때문에 새로 만든 폴더를 그 맥이 지운다. 폴더를 정해 맡겼거나 같은 폴더를 쓰는 다른 세션이 있으면 남기고, 맡긴 쪽에 그 결과 한 줄을 남긴다',
        refs: ['REQ-F-760'],
      },
    ],
  },
  {
    version: '1.389',
    date: '2026-11-02',
    commit: '8fb1cae',
    changes: [
      {
        kind: 'changed',
        scope: ['agent'],
        text: 'zeropty 세션의 claude 는 zeropty-tty(서명을 바꾼 claude 사본 + DYLD_INSERT_LIBRARIES) 대신 런타임 어댑터(BUN_OPTIONS=--preload)로 터미널을 본다. claude 바이너리·서명은 그대로. 어댑터가 막혀 터미널을 못 보면 그 세션과 다음 세션은 tmux 로',
        refs: ['REQ-F-794'],
      },
    ],
  },
  {
    version: '1.388',
    date: '2026-11-02',
    commit: 'bbcc606',
    changes: [
      {
        kind: 'fixed',
        scope: ['server', 'ui'],
        text: '디스크 관리 기기 줄의 세션 정리 숫자를 펼친 목록과 같은 기준으로: "내릴 세션 · 휴면·끝내기 제안 · 폴더·기록 제안". 끝낸 세션은 바로 빠지고, 다시 계산 뒤 줄도 바로 바뀐다',
        refs: ['REQ-F-839'],
      },
    ],
  },
  {
    version: '1.387',
    date: '2026-11-02',
    commit: 'b6e5dbf',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: '세션 정리에서 끝내기·휴지통·유지 같은 동작을 누르면 그 줄이 바로 "처리 중"으로 흐려지고, 잠시 뒤 목록을 자동으로 다시 계산한다(연달아 누르면 한 번만). 꺼진 세션 줄에 "휴면" 단추',
        refs: ['REQ-F-839'],
      },
    ],
  },
  {
    version: '1.386',
    date: '2026-11-02',
    commit: 'a63f4fc',
    changes: [
      {
        kind: 'fixed',
        scope: ['agent'],
        text: '새로 여는 zeropty 세션은 bridge 전용 소켓에서 돈다. 소켓을 지정하지 않은 `zeropty kill-server` 가 bridge 세션을 모두 끄던 일을 막는다. 이미 돌던 세션은 끝나거나 다시 열 때까지 옛 소켓에서 그대로',
        refs: ['REQ-F-841', 'REQ-F-794'],
      },
    ],
  },
  {
    version: '1.385',
    date: '2026-11-02',
    commit: 'd3aacc5',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server', 'ui'],
        text: '세션 정리: 에이전트가 1시간마다 사람 입력이 오래 없는 세션의 claude 를 하루 전 예고 뒤 내리고(기본 3일, 대화는 남음), 오래 안 쓴 깨끗한 작업 폴더만 휴지통으로 옮기며(기본 14일), 나머지는 제안으로 보여 준다. 처음 7일과 다른 사용자 기기는 제안만',
        refs: ['REQ-F-835', 'REQ-F-836', 'REQ-F-837', 'REQ-F-838'],
      },
      {
        kind: 'added',
        scope: ['ui'],
        text: '디스크 관리의 기기마다 "세션 정리" 칸(오래 쉰 세션·정리 제안 폴더·큰 대화 기록, 방식과 일수 설정), 세션 화면의 내림 예고 띠와 메뉴의 "자동 종료 안 함"',
        refs: ['REQ-F-839'],
      },
      {
        kind: 'added',
        scope: ['server'],
        text: 'bridge.yaml 의 tidy.* 기본값과 계정·기기별 설정, 정리 기록(area tidy)과 하루 요약 알림',
        refs: ['REQ-F-840', 'REQ-F-812'],
      },
    ],
  },
  {
    version: '1.384',
    date: '2026-11-01',
    commit: '2e42d24',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server', 'agent'],
        text: '모델 라우팅(설정 → 새 세션, 기본 꺼짐): 켜면 새로 여는 세션에 일꾼 서브에이전트 6개(checker·Explore·researcher·ops-runner·doc-writer·reviewer, 각자 모델·effort)를 --agents 로, 서브에이전트 기본 모델을 CLAUDE_CODE_SUBAGENT_MODEL 로 넣고, 시스템 프롬프트에 맡기는 규칙(품질 위험 일은 opus)을 덧붙임. 세션 설정에 라우팅 켜짐 여부',
        refs: ['REQ-F-834', 'IF-261'],
      },
    ],
  },
  {
    version: '1.383',
    date: '2026-11-01',
    commit: 'f476784',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server'],
        text: 'bridge MCP delegate 도구가 맡길 세션의 model(별칭·전체 모델 ID)과 effort(low~max)를 받음. 비우면 그 사람의 기본값, 틀리면 거절. 응답과 두 세션의 알림에 실제로 쓴 모델·effort 가 보임',
        refs: ['REQ-F-760', 'IF-260', 'ERR-345', 'ERR-346'],
      },
    ],
  },
  {
    version: '1.382',
    date: '2026-11-01',
    commit: 'fb4cebc',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'ui'],
        text: '`node agent.mjs link --visible` 과 기기 화면의 "보이는 창으로 로그인": 헤드리스와 같은 Chrome 프로필로 보이는 창을 열어 앞단 프록시 로그인을 마치면, 40초 뒤 창을 닫고 그 쿠키로 헤드리스를 다시 띄움',
        refs: ['REQ-F-833', 'IF-178'],
      },
      {
        kind: 'added',
        scope: ['agent', 'server', 'ui'],
        text: '헤드리스 페이지의 연동 요청이 다른 주소로 넘어가거나 401·HTML 이면 "로그인 필요"로 표시(기기 화면·점검)하고, 서버가 받으면 새 이벤트 host.login_required(notify·hooks)를 냄',
        refs: ['REQ-F-833', 'REQ-F-817', 'REQ-F-818', 'REQ-F-819'],
      },
      {
        kind: 'changed',
        scope: ['server', 'ui'],
        text: 'auth.headerOnly 서버도 헤드리스 연동 켜기·다시 띄우기를 막지 않음(409 없앰). features.background 는 늘 참, 새 features.proxyLogin. 화면은 화면 없는 기기 연결·폰에서 열기만 숨김',
        refs: ['REQ-F-816', 'REQ-F-812'],
      },
      {
        kind: 'added',
        scope: ['agent'],
        text: 'agent.json 의 chromeFlags.localNetwork·mockKeychain 을 false 로 두면 헤드리스 Chrome 에 --disable-features=LocalNetworkAccessChecks·--use-mock-keychain 을 붙이지 않음(기본은 그대로)',
        refs: ['REQ-F-833'],
      },
      {
        kind: 'changed',
        scope: ['server'],
        text: '프록시 로그인 안내 문구를 일반 표현으로: "이 서버는 앞단 프록시 로그인으로만 들어와요"',
        refs: ['REQ-F-816', 'REQ-F-814'],
      },
    ],
  },
  {
    version: '1.381',
    date: '2026-11-01',
    commit: '7c3ceff',
    changes: [
      {
        kind: 'security',
        scope: ['agent'],
        text: '안전한 전부 허용이 `git --git-dir <폴더> clean -f` 처럼 값을 띄어 쓴 git 전역 옵션 뒤의 작업 버리기(clean·checkout·restore)도 묻는다',
        refs: ['REQ-F-759'],
      },
      {
        kind: 'security',
        scope: ['server'],
        text: 'GitHub 로그인 설정 없음·로그인 콜백 오류·QR 만료 페이지에도 CSP·nosniff 등 보안 머리글과 no-store, 연동 탭이 받는 올린 파일에 nosniff·attachment',
        refs: ['REQ-S-011', 'IF-219'],
      },
    ],
  },
  {
    version: '1.380',
    date: '2026-11-01',
    commit: 'b83b5c6',
    changes: [
      {
        kind: 'added',
        scope: ['server'],
        text: '자동 수정 서버 같은 믿을 수 있는 서버가 서비스 토큰으로 내 맥 목록(이름·연결 여부·OS·에이전트 버전)을 읽을 수 있다. 자산 목록을 손으로 적지 않으려는 것',
        refs: ['REQ-F-799', 'IF-259'],
      },
    ],
  },
  {
    version: '1.379',
    date: '2026-11-01',
    commit: 'bd194de',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: '새 버전 안내에서 "하루 동안 안 보기"를 누르면 새로 배포돼도 24시간 동안 다시 뜨지 않는다(모든 맥 공통). "나중에"도 그 페이지를 연 동안은 새 배포에 다시 뜨지 않는다',
        refs: ['REQ-F-832'],
      },
    ],
  },
  {
    version: '1.378',
    date: '2026-11-01',
    commit: 'd3a6ef8',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server', 'agent'],
        text: '새벽 자동 업데이트는 작업 중인 세션이 있으면 모두 쉴 때까지 기다리고, 시간이 끝날 때까지 바쁘면 다음 날로 미룬다. 맥 화면에서 켜고 끌 수 있고 기본은 켜짐',
        refs: ['REQ-F-832', 'IF-258'],
      },
    ],
  },
  {
    version: '1.377',
    date: '2026-11-01',
    commit: 'ce3eed8',
    changes: [
      {
        kind: 'changed',
        scope: ['agent'],
        text: '에이전트 자동 업데이트가 기본으로 그 맥의 새벽 4~6시에만 새 버전으로 바뀐다. 작업 중에 다시 시작해 하던 일이 끊기지 않게',
        refs: ['REQ-F-832', 'REQ-F-368'],
      },
      {
        kind: 'added',
        scope: ['ui', 'server', 'agent'],
        text: '맥 화면의 자동 업데이트: 정해진 시간에만·받는 대로, 시작·끝 시각 고르기, 받아 둔 새 버전을 지금 업데이트',
        refs: ['REQ-F-832', 'IF-258'],
      },
      {
        kind: 'added',
        scope: ['ui'],
        text: '새 버전을 받아 둔 맥이 있으면 "새 버전이 있어요" 안내: 지금 업데이트·나중에·하루 동안 안 보기',
        refs: ['REQ-F-832'],
      },
    ],
  },
  {
    version: '1.376',
    date: '2026-11-01',
    commit: '9ad1eb3',
    changes: [
      {
        kind: 'changed',
        scope: ['server'],
        text: '서비스 API(자동 수정 서버)가 닫은 세션은 세션 목록(이어서 하기)에서도 바로 빠진다. 전에 닫혀 남아 있던 서비스 세션도 정리한다. 두 번째 닫기는 404. 맥의 폴더와 대화는 남는다',
        refs: ['REQ-F-799', 'REQ-F-742', 'IF-253'],
      },
    ],
  },
  {
    version: '1.375',
    date: '2026-11-01',
    commit: 'f6b843e',
    changes: [
      {
        kind: 'security',
        scope: ['agent'],
        text: '안전한 전부 허용이 커밋 안 한 작업을 버리는 명령(git clean -f, git checkout -- ./-f, git restore)과 find -delete·-exec rm 도 묻고 실행해요. git restore --staged 만 쓴 것은 그대로 허용',
        refs: ['REQ-F-759', 'AC-1500'],
      },
    ],
  },
  {
    version: '1.374',
    date: '2026-10-31',
    commit: '37a2851',
    changes: [
      { kind: 'fixed', scope: ['server'], text: '맥과의 연결이 10초 안에 다시 붙으면 기기가 끊김으로 깜빡이지 않고 경고도 남지 않아요. 서버와 같은 기기에서 Docker 컨테이너가 뜰 때마다 끊겼다 붙던 것이 보이지 않아요. 다시 붙는 데도 3초 대신 1초', refs: ['REQ-F-831'] },
    ],
  },
  {
    version: '1.373',
    commit: '878d565',
    date: '2026-10-31',
    changes: [
      { kind: 'fixed', scope: ['server'], text: '처리방침의 수신처 문장에 보낸 글·누른 키 같은 동작의 내용과 익스텐션 라우트로 가는 내용도 간다고 적었어요', refs: ['REQ-F-818'] },
      { kind: 'fixed', scope: ['ui'], text: 'Slack 을 끈 서버에서도 익스텐션이 있으면 설정의 플러그인 탭이 보여요', refs: ['REQ-F-812'] },
    ],
  },
  {
    version: '1.372',
    commit: '1a97016',
    date: '2026-10-31',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: '즐겨찾기 별·열쇠 같은 글 속 아이콘이 글자 가운데에 맞아요. 별 있는 세션 줄만 조금 높던 것도 없어졌어요', refs: ['REQ-F-782'] },
      { kind: 'fixed', scope: ['ui'], text: '세션 줄의 제목과 시간이 같은 기준선에 놓이고, 목록 요약 줄·절 제목·상태 점·분할 조합이 한 왼쪽 선에 맞아요. 절과 절 사이를 8 px 띄웠어요', refs: ['REQ-F-698', 'REQ-F-119'] },
      { kind: 'changed', scope: ['ui'], text: '650·700 이던 굵은 글자를 모두 600 으로 낮추고, 시간·컨텍스트·세션 수 숫자는 폭이 같은 숫자로 그려요', refs: ['REQ-F-698', 'REQ-F-119', 'REQ-F-778'] },
      { kind: 'fixed', scope: ['ui'], text: '도구 줄 상태 아이콘이 칸을 넘지 않고, 머리줄 경로 앞 간격·정렬 단추와 메뉴 판의 안쪽 둥글기가 맞아요. 폰 입력 카드 모서리를 30 px 로 넓혀 둥근 단추가 테두리에 닿지 않아요', refs: ['REQ-F-177', 'REQ-F-724'] },
      { kind: 'changed', scope: ['ui'], text: '빈 홈 제목 "어서 오세요!" 를 "맥을 연결해 주세요" 로, 제보·가이드 문구의 느낌표를 빼고, 제보 말풍선의 🎬 를 재생 아이콘으로 바꿨어요', refs: ['REQ-F-545', 'REQ-F-735'] },
    ],
  },
  {
    version: '1.371',
    commit: '39dd0b7',
    date: '2026-10-31',
    changes: [
      { kind: 'changed', scope: ['ui'], text: '반짝이 아이콘을 뜻에 맞는 아이콘으로 바꿨어요. 지금 압축은 새 압축 아이콘, 가벼운 복제는 번개, 할 일 정리는 문서, 큰 대화 기록 경고는 경고 아이콘이에요', refs: ['REQ-F-776', 'REQ-F-610'] },
      { kind: 'changed', scope: ['server'], text: '권한 모드 목록의 "전부 허용" 앞 🔴 를 뺐어요. 빨간 글자로 그대로 구분돼요', refs: ['REQ-F-796'] },
      { kind: 'changed', scope: ['ui'], text: '배지·말풍선·세그먼트 버튼 등의 좌우 여백을 4 px 단위로 맞췄어요', refs: ['REQ-F-724'] },
    ],
  },
  {
    version: '1.370',
    commit: '20c3786',
    date: '2026-10-31',
    changes: [
      { kind: 'changed', scope: ['ui'], text: '즐겨찾기 별을 노란색에서 흐린 회색으로 바꿔, 세션 줄마다 상태 점만 색을 띠어요', refs: ['REQ-F-782'] },
      { kind: 'changed', scope: ['ui'], text: '로고·읽지 않은 세션 제목·절 제목 같은 굵은 글자를 600 으로 낮추고, 절 제목의 넓힌 자간을 없앴어요' },
      { kind: 'changed', scope: ['ui'], text: '확인 창과 설명 글의 🔴·⚠️ 이모지를 빼고, 첨부 이름 앞의 🎬·📎 는 재생·문서 아이콘으로 바꿨어요', refs: ['REQ-F-702', 'REQ-F-796'] },
      { kind: 'changed', scope: ['ui'], text: '알림이 튀어 오르지 않고 부드럽게 나타나요. 떠 있는 유리 막대가 뒤 색을 더 진하게 만들지 않아요', refs: ['REQ-F-724'] },
      { kind: 'removed', scope: ['ui'], text: '예전 화면에서 쓰이지 않던 무지개 활동 상자 스타일을 지우고, 시작 페이지 카드 제목의 이모지를 뺐어요' },
    ],
  },
  {
    version: '1.369',
    commit: '8ba5f22',
    date: '2026-10-31',
    changes: [
      { kind: 'added', scope: ['ui', 'server', 'agent'], text: '사진·영상 말고 아무 파일이나 보낼 수 있어요(하나에 512MB, 영상과 합쳐 한 번에 3개). 입력창 + 와 새 세션의 "사진·파일 붙이기", 끌어 놓기로 붙이면 원본 그대로 올라가 세션의 맥 ~/.claude-bridge/images 에 원래 이름으로 놓이고, 메시지에 그 경로가 붙어요. 대화에는 📎 이름', refs: ['REQ-F-830', 'IF-218'] },
      { kind: 'changed', scope: ['ui', 'server'], text: '영상 한도도 500MB 에서 512MB 로', refs: ['REQ-F-761'] },
    ],
  },
  {
    version: '1.368',
    commit: 'b9ac6be',
    date: '2026-10-31',
    changes: [
      { kind: 'changed', scope: ['server'], text: '익스텐션 라우트 경로가 틀렸을 때 오류 문구의 예시가 /docs/ 로 바뀌었어요', refs: ['REQ-F-825'] },
    ],
  },
  {
    version: '1.367',
    commit: 'b76f363',
    date: '2026-10-31',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: 'entry 가 하위 폴더(dist/ 등)에 있는 익스텐션의 글이 번역 키 그대로 보이던 것을 고쳤어요. 언어 파일은 익스텐션 폴더의 locales/ 에서 읽어요', refs: ['REQ-F-827'] },
    ],
  },
  {
    version: '1.366',
    commit: '2abb630',
    date: '2026-10-31',
    changes: [
      { kind: 'added', scope: ['ui', 'server'], text: '익스텐션을 만드는 사람을 위한 타입 정의와 예시 익스텐션을 저장소에 두었어요(extensions/). 익스텐션 폴더의 node_modules 와 숨김 파일은 서버가 읽지 않아요', refs: ['REQ-F-829', 'REQ-F-825'] },
    ],
  },
  {
    version: '1.365',
    commit: '44d3924',
    date: '2026-10-31',
    changes: [
      { kind: 'changed', scope: ['ui'], text: '답 안 html 미리보기가 익스텐션과 같은 렌더러 처리기로 붙어요. 익스텐션이 html 블록을 대신 그릴 수 있고, 익스텐션이 없으면 보이는 것은 그대로예요', refs: ['REQ-F-604', 'REQ-F-822'] },
    ],
  },
  {
    version: '1.364',
    commit: 'b9857cf',
    date: '2026-10-31',
    changes: [
      {
        kind: 'changed',
        scope: ['server'],
        text: '제보 자동 대응 세션이 배포를 마치고 스스로 종료하면 세션 목록(이어서 하기)에서도 바로 빠진다. 전에 그렇게 종료돼 남아 있던 세션도 정리한다. 맥의 폴더와 대화는 남는다',
        refs: ['REQ-F-738', 'REQ-F-742'],
      },
    ],
  },
  {
    version: '1.363',
    date: '2026-10-31',
    commit: 'a0878bc',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: '새 세션의 첫 메시지에 사진·영상을 붙일 수 있음("사진·영상 붙이기" 버튼, 붙여 넣기·끌어 놓기, 그림 8장·영상 3개). 붙인 것이 있으면 세션을 띄운 뒤 영상을 올리고 글·그림·영상을 한 번에 보냄',
        refs: ['REQ-F-828', 'AC-1496'],
      },
    ],
  },
  {
    version: '1.362',
    date: '2026-10-31',
    commit: '0badfa2',
    changes: [
      {
        kind: 'security',
        scope: ['server'],
        text: '익스텐션이 읽는 환경변수 제한을 YAML 이스케이프(\\u0024{…})로 지나가 허락하지 않은 서버 환경변수를 보내는 곳에 넣을 수 있던 것: 치환 자체가 extensions[].env 의 이름만 읽고, 다른 이름이면 불러오지 않는다',
        refs: ['REQ-S-088', 'REQ-F-825', 'AC-1495'],
      },
      {
        kind: 'security',
        scope: ['server'],
        text: '운영 탭의 붙여 넣고 검사가 같은 이스케이프로 이 서버의 다른 환경변수 값을 오류 문구에 보이던 것: 치환이 허락한 이름만 읽고 다른 이름은 unsubstituted 로 돌려준다',
        refs: ['REQ-S-088', 'REQ-F-810', 'IF-257'],
      },
    ],
  },
  {
    version: '1.361',
    date: '2026-10-31',
    commit: 'e68099a',
    changes: [
      { kind: 'added', scope: ['ui'], text: '이 서버에 익스텐션이 있으면 처음 열 때 켤지 물어요. 켜면 입력칸·메뉴·목록·설정에 그 기능이 더해지고, 설정 → 플러그인에서 끌 수 있어요. 주소 끝에 ?noext=1 을 붙이면 익스텐션 없이 열어요', refs: ['REQ-F-827'] },
    ],
  },
  {
    version: '1.360',
    commit: '0d7892d',
    date: '2026-10-31',
    changes: [
      { kind: 'added', scope: ['server'], text: '익스텐션이 서버에 작은 값과 비밀값을 저장하고, extension.yaml 에 적은 주소로만 서버를 거쳐 요청하고, 턴 끝·카드 이벤트를 받아 한 화면만 맡을 수 있어요', refs: ['REQ-F-826'] },
    ],
  },
  {
    version: '1.359',
    commit: '6382c70',
    date: '2026-10-31',
    changes: [
      { kind: 'added', scope: ['server'], text: '운영자가 bridge.yaml 의 extensions 로 익스텐션 폴더를 둘 수 있어요. 서버는 그 파일을 동의한 사람에게만 내주고, 받는 주소를 처리방침에 싣어요. 화면에서 불러오는 것은 다음 판이에요', refs: ['REQ-F-825'] },
    ],
  },
  {
    version: '1.358',
    commit: '62e1cd6',
    date: '2026-10-31',
    changes: [
      { kind: 'changed', scope: ['ui'], text: '입력칸의 버튼 줄, 세션 메뉴, 목록의 배지, 설정 탭에 나중에 익스텐션이 항목을 더할 자리를 만들었어요. 세션 메뉴는 목록과 세션 화면이 한 목록을 같이 써요. 보이는 메뉴와 단축키는 그대로예요', refs: ['REQ-F-824'] },
    ],
  },
  {
    version: '1.357',
    commit: '4a2d75c',
    date: '2026-10-31',
    changes: [
      { kind: 'changed', scope: ['ui'], text: '보내기, 카드 답, 새 세션, 세션 끝내기·지우기도 이름 붙은 액션을 거쳐요. 지금 보이는 동작은 그대로예요', refs: ['REQ-F-823'] },
    ],
  },
  {
    version: '1.356',
    commit: '2b86307',
    date: '2026-10-31',
    changes: [
      { kind: 'changed', scope: ['ui'], text: '화면 안의 동작(세션 열기, 링크 열기, 복사, 코드 블록 그리기, 서버 알림)이 이름 붙은 액션을 거쳐요. 나중에 이 서버의 익스텐션이 끼어들 자리예요. 지금 보이는 동작은 그대로예요', refs: ['REQ-F-822'] },
    ],
  },
  {
    version: '1.355',
    commit: '95f7955',
    date: '2026-10-30',
    changes: [
      { kind: 'added', scope: ['agent'], text: 'agent.json 의 hooks: 이 맥에서 세션이 열리거나 닫히거나 턴이 끝나면 정한 명령을 셸 없이 실행(이벤트는 stdin). 잘못된 항목과 실행할 수 없는 명령은 점검 화면에 보임', refs: ['REQ-F-821'] },
    ],
  },
  {
    version: '1.354',
    commit: '9c94402',
    date: '2026-10-30',
    changes: [
      { kind: 'added', scope: ['server'], text: 'bridge.yaml 의 hooks 에 before 훅: 액션 직전에 묻고, 막으면 그 이유를 보여 주고, 보낼 글·세션 제목·첫 지시·권한 모드를 바꿀 수 있음. 묻는 동안 다른 요청은 기다리지 않고, 그사이 세션이 바뀌면 다시 하게 함. 확인 서버가 죽으면 기본은 그대로 진행(onError: deny 로 막기)', refs: ['REQ-F-820'] },
      { kind: 'changed', scope: ['server'], text: '다른 질문 카드가 열려 있는데 옛 카드에 답하면 "다른 질문이 열려 있어요" 로 알림(전에는 맥이 조용히 무시)', refs: ['REQ-F-820'] },
    ],
  },
  {
    version: '1.353',
    commit: '7a86a37',
    date: '2026-10-30',
    changes: [
      { kind: 'added', scope: ['server'], text: 'bridge.yaml 의 hooks: 세션 만들기·닫기, 글 보내기, 카드 답, 설정 바꾸기 같은 액션과 턴 끝·카드 이벤트 뒤에 웹훅이나 서버 안 명령을 부름(after, 한 번, 서명). 누가 했는지(page·slack·service·delegate·system)는 요청이 들어온 길로 정함', refs: ['REQ-F-819'] },
      { kind: 'added', scope: ['server'], text: 'notify 가 액션 이벤트(session.create, message.send, permission.answer …)도 받음. 훅의 수신처도 처리방침과 설정 화면의 목록에 보임', refs: ['REQ-F-818', 'REQ-F-819'] },
    ],
  },
  {
    version: '1.352',
    commit: 'f3506a6',
    date: '2026-10-30',
    changes: [
      { kind: 'added', scope: ['server'], text: '서버가 이벤트를 냄: login, session.done(턴 끝), decision.waiting(권한·질문 카드가 열림), decision.answered(어떻게 답했는지). 맥 쪽 보고에서 나온 이벤트는 감사 기록으로 믿지 않음', refs: ['REQ-F-817'] },
      { kind: 'added', scope: ['server'], text: 'bridge.yaml 의 notify: 고른 이벤트를 웹훅으로 보냄. HMAC 서명(타임스탬프·nonce·본문 해시), 실패하면 1초·10초·60초 뒤 다시', refs: ['REQ-F-818'] },
      { kind: 'added', scope: ['server', 'ui'], text: '수신처가 있으면 개인정보 처리방침에 수신처 목록(출처와 이벤트만)이 들어가고, 설정 → 더 보기에 "이 서버가 대화를 보내는 곳" 이 보임', refs: ['REQ-F-818'] },
      { kind: 'fixed', scope: ['ui'], text: '헤더 로그인만 받는 서버의 기기 화면에서 쓸 수 없는 "폰에서 열기"(QR 로그인)를 숨김', refs: ['REQ-F-816'] },
      { kind: 'fixed', scope: ['server'], text: '운영 탭의 설정 글 가리기가 경로 없는 주소의 마지막 글자를 자르던 것을 고침. 주소의 user:password@ 도 가림', refs: ['REQ-F-810'] },
    ],
  },
  {
    version: '1.351',
    commit: 'e28948c',
    date: '2026-10-30',
    changes: [
      { kind: 'added', scope: ['server', 'ui'], text: 'bridge.yaml 의 auth.headerOnly: 프록시의 헤더 로그인만 받음. GitHub·Apple·데모·QR 로그인 입구를 닫고, 헤더 없이 온 쿠키는 받지 않으며, 로그인 화면 대신 "프록시를 거쳐 다시 열어 주세요"', refs: ['REQ-F-816'] },
      { kind: 'added', scope: ['server', 'ui'], text: '헤더 로그인만 받는 서버에서는 헤드리스 연동·화면 없는 기기 연결을 끔(켜기 409, 끄기는 열림). 기기 화면은 켜져 있는 맥에 끄는 방법을 보임', refs: ['REQ-F-816'] },
      { kind: 'added', scope: ['server', 'ui'], text: '설정 검사가 headerOnly 를 켜는 파일이면 헤드리스 연동이 켜져 있거나 알 수 없는 맥과 화면 없는 기기를 먼저 끌 기기로 보임', refs: ['REQ-F-816'] },
    ],
  },
  {
    version: '1.350',
    commit: 'b64ffe1',
    date: '2026-10-30',
    changes: [
      { kind: 'added', scope: ['server'], text: 'bridge.yaml 의 auth.providers trusted-header: 앞단 프록시(SSO)가 확인한 이메일로 로그인. secret 이 맞고 프록시 주소(trustFrom)에서 온 요청만 믿고, 처음이면 계정을 만들고 같은 로그인 쿠키를 줌. 허용되지 않은 사람은 승인 대기 화면', refs: ['REQ-F-814'] },
      { kind: 'added', scope: ['server', 'ui'], text: 'bridge.yaml 의 origins.extra: 한 서버를 여러 주소로 엶(헤더 로그인이 있을 때만). 다른 주소로 온 요청은 421, 추가 주소의 페이지는 맥과 연동하지 않음', refs: ['REQ-F-815'] },
      { kind: 'changed', scope: ['server'], text: '무중단 교체 중 넘겨받은 요청의 원래 주소를 옛 서버가 서명해 넘김(프록시 주소 확인이 교체 중에도 맞게)', refs: ['REQ-F-814'] },
    ],
  },
  {
    version: '1.349',
    commit: '465f71e',
    date: '2026-10-30',
    changes: [
      { kind: 'added', scope: ['agent'], text: 'node agent.mjs start: 에이전트가 없을 때만 백그라운드로 띄우고 종료 0(이미 있으면 아무것도 안 함). cron·Raycast 같은 바깥 주기 실행에서 부르면 됨. 로그는 ~/.claude-bridge/detached.log', refs: ['REQ-F-813'] },
      { kind: 'added', scope: ['agent'], text: 'start 로 띄운 에이전트는 사이트에서 다시 시작할 수 있고, 업데이트·다시 시작 뒤 스스로 이어 뜸. 포트가 쓰이는 중이면 옆 포트로 옮기지 않고 끝남', refs: ['REQ-F-813'] },
      { kind: 'added', scope: ['agent'], text: 'start 로 띄웠는데 tmux·claude 를 못 찾으면 점검이 "start 의 PATH" 경고와 함께 터미널에서 한 번 실행해 PATH 를 저장하라고 안내', refs: ['REQ-F-813'] },
      { kind: 'added', scope: ['agent'], text: 'agent.json supervisor: none(--supervisor none): 서비스가 설치돼 있으면 점검이 경고하고 service uninstall 을 권함', refs: ['REQ-F-813'] },
    ],
  },
  {
    version: '1.348',
    commit: '72068f0',
    date: '2026-10-30',
    changes: [
      { kind: 'added', scope: ['ui', 'server'], text: 'bridge.yaml 의 features 로 다른 맥으로 옮기기·위임, 웹 알림, 음성, 서버 미리보기, 스킬, Slack, 키 입력을 끌 수 있음. 꺼진 기능의 API 는 403 "이 서버에서 꺼진 기능이에요", 화면은 그 입구를 숨김', refs: ['REQ-F-812'] },
      { kind: 'added', scope: ['ui', 'server'], text: 'features.permissionModes 로 고를 수 있는 권한 모드를 정함. 목록 밖 모드는 manual 로 낮추고 전부 허용은 켜지 않으며, 세션 설정에서 목록 밖으로 바꾸면 403', refs: ['REQ-F-812'] },
      { kind: 'added', scope: ['server'], text: 'retention.uploadsHours(업로드 보관 시간)·retention.previews(세션 미리보기 문구 저장), csp.frameSrc·csp.imgSrc(https 출처만), privacy.file(내 처리방침 페이지)', refs: ['REQ-F-812'] },
      { kind: 'added', scope: ['server'], text: '호스트가 마지막으로 알린 헤드리스 연동 상태와 시각을 기기 기록에 남김', refs: ['REQ-F-811'] },
    ],
  },
  {
    version: '1.347',
    commit: 'ca8451d',
    date: '2026-10-29',
    changes: [
      { kind: 'added', scope: ['server'], text: '서버 설정 파일 bridge.yaml(BRIDGE_CONFIG, 기본 <BRIDGE_DATA>/bridge.yaml). origins.primary·auth.allow·auth.admins·retention.allowPurge 를 받고, 같은 뜻의 환경변수는 기본값. 틀린 파일이면 시작하지 않고(옛 인스턴스가 계속 일함) config-error.json 을 남김', refs: ['REQ-F-809'] },
      { kind: 'added', scope: ['ui', 'server'], text: '운영 탭 "설정 파일": 지금 환경변수를 참조로만 담은 bridge.yaml 내보내기(복사·내려받기·이 서버에 저장), 붙여 넣고 검사, 지금 파일 검사. 명령줄 bridge-server config export|check', refs: ['REQ-F-810', 'IF-254', 'IF-255', 'IF-256', 'IF-257'] },
      { kind: 'changed', scope: ['ui', 'server'], text: '파일 값 때문에 환경변수 수정이 반영되지 않는 키는 운영 탭 맨 위에 경고. 출처 없음·데이터 정리 꺼짐 문구에 bridge.yaml 키 이름도 적음', refs: ['REQ-F-809', 'REQ-S-075'] },
      { kind: 'fixed', scope: ['server'], text: '설정 파일은 시작 때의 소유자 바꾸기에서 빼서, 읽기 전용으로 마운트해도 서버 전체가 root 로 남지 않음', refs: ['REQ-F-809', 'REQ-S-066'] },
    ],
  },
  {
    version: '1.346',
    commit: '6ab8993',
    date: '2026-10-29',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: 'tmux 로 고정한 기기(--mux tmux)는 zeropty 를 받지 않음. 그 기기에 zeropty 세션이 남아 있으면 지금처럼 받음. 점검 zeropty 는 받지 않은 경우 ok', refs: ['REQ-F-794'] },
      { kind: 'changed', scope: ['server'], text: 'Dockerfile 베이스 이미지를 빌드 인자 NODE_IMAGE·GO_IMAGE·RUN_IMAGE 로 바꿀 수 있음(기본값은 지금 이미지)' },
    ],
  },
  {
    version: '1.345',
    commit: '515207d',
    date: '2026-10-29',
    changes: [
      { kind: 'changed', scope: ['ui'], text: 'iOS 카메라 번역: 언어 받기가 1분 넘게 안 끝나면 안내(인터넷 확인, 설정 → 앱 → 번역)와 "다시 받기" 단추를 보임', refs: ['REQ-F-808'] },
    ],
  },
  {
    version: '1.344',
    commit: '5ce6fec',
    date: '2026-10-29',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: 'iOS 카메라 번역: 처음 언어팩을 받는 동안 멈춘 것처럼 보이던 것을 고침. 받는 동안은 "언어 받는 중…" 을 보이고, 다 받으면 바로 번역함', refs: ['REQ-F-808'] },
    ],
  },
  {
    version: '1.343',
    commit: '149bf49',
    date: '2026-10-29',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: 'iOS 앱에서 세션 줄을 길게 누르면 빈 링크 미리보기(링크 열기·복사·공유)가 뜨던 것을 고쳐, 원래 세션 메뉴가 뜸', refs: ['REQ-F-756'] },
    ],
  },
  {
    version: '1.342',
    commit: '75fbc2a',
    date: '2026-10-29',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: 'iOS 앱 TestFlight 자동 올리기가 Xcode 로그인 없이 App Store Connect API 키와 배포 프로필로 서명함. Xcode 계정이 풀려 1.341 이 올라가지 못했음', refs: ['REQ-F-762'] },
    ],
  },
  {
    version: '1.341',
    commit: '6c86736',
    date: '2026-10-29',
    changes: [
      { kind: 'added', scope: ['ui'], text: 'iOS 앱 카메라 번역(시험): 앱 아이콘을 길게 눌러 "카메라 번역 (시험)" 을 고르면 카메라에 비친 일본어를 바로 한국어로 얹어 보임. 읽기·번역 모두 기기 안에서 해서, 처음 한 번 언어를 받으면 인터넷 없이 됨(iOS 18 이상)', refs: ['REQ-F-808'] },
    ],
  },
  {
    version: '1.340',
    commit: 'd14e534',
    date: '2026-10-29',
    changes: [
      { kind: 'security', scope: ['server'], text: '조작 페이지·연동 탭의 이벤트 스트림은 받는 쪽이 읽지 않아 보내지 못한 것이 64 MiB 를 넘게 되면 끊음. 지금까지는 서버 메모리에 끝없이 쌓였음. 페이지는 다시 연결해 전체 상태를 받음', refs: ['REQ-S-087', 'IF-015', 'IF-075'] },
      { kind: 'security', scope: ['server'], text: '한 사람이 여는 조작 페이지 스트림은 32 개까지, 하나 더 열면 가장 오래된 것을 닫음', refs: ['REQ-S-087', 'IF-015'] },
    ],
  },
  {
    version: '1.339',
    commit: '58c432b',
    date: '2026-10-28',
    changes: [
      { kind: 'added', scope: ['server'], text: '서비스 API 로 연 세션을 닫는 POST /api/service/sessions/<sid>/close. 자동 수정 서버가 끝난 세션을 닫아 맥의 CPU·메모리를 돌려받음. 이미 닫혔으면 그대로 200, 사람이 연 세션·남의 세션은 404', refs: ['REQ-F-799', 'IF-253'] },
    ],
  },
  {
    version: '1.338',
    commit: 'efc710e',
    date: '2026-10-28',
    changes: [
      { kind: 'security', scope: ['agent'], text: "안전한 전부 허용은 따옴표 안(bash -c 'sudo …')·백틱·경로(/usr/bin/sudo)·\\sudo 로 쓴 sudo 도 물음. 관리자 비밀번호가 열린 동안 묻지 않고 root 로 돌 수 있었음", refs: ['REQ-F-759', 'REQ-F-764'] },
      { kind: 'security', scope: ['agent'], text: 'git push 의 붙여 쓴 옵션(-fu), --mirror, 원격 브랜치 지우기(--delete·-d·:ref·--prune), --force-if-includes 도 강제 push 로 물음', refs: ['REQ-F-759'] },
    ],
  },
  {
    version: '1.337',
    commit: '6577f9a',
    date: '2026-10-27',
    changes: [
      { kind: 'security', scope: ['server'], text: '미리보기 웹소켓은 조각(continuation)을 합친 메시지가 16 MB 를 넘으면 1009 로 닫음. 프레임 하나만 막고 합친 크기는 보지 않았음', refs: ['REQ-S-086', 'IF-201'] },
      { kind: 'security', scope: ['server'], text: '영상 올리기는 한 사람의 영상(남은 올린 영상·올리는 중·제보에 붙은 영상)을 합쳐 2 GiB 까지. 넘으면 413', refs: ['REQ-S-086', 'REQ-F-761'] },
    ],
  },
  {
    version: '1.336',
    commit: '86a4231',
    date: '2026-10-26',
    changes: [
      { kind: 'security', scope: ['server'], text: '서비스 API 는 토큰이 맞아도 BRIDGE_SERVICE_UID 의 계정이 없거나 허용 목록에서 빠졌으면 403. 계정을 막으면 토큰도 바로 막힘', refs: ['REQ-S-085', 'REQ-F-799'] },
      { kind: 'security', scope: ['server', 'ui'], text: '디스크 정리 도움의 허용은 주인이 본 운영자(login)에게만 감. 그사이 다른 운영자가 요청을 덮어썼으면 409', refs: ['REQ-F-804', 'IF-252'] },
      { kind: 'security', scope: ['agent'], text: '디스크 관리의 폴더 보기는 홈 밖이나 macOS 가 지키는 폴더를 가리키는 링크를 따라가지 않음', refs: ['REQ-F-804', 'IF-251'] },
    ],
  },
  {
    version: '1.335',
    commit: '6b27dad',
    date: '2026-10-26',
    changes: [
      { kind: 'added', scope: ['server', 'ui'], text: '운영 페이지에서 다른 사용자 기기의 배터리도 보임(사이클·최대 용량 포함). 꺼져 있거나 끊긴 기기는 마지막으로 받은 값과 그 시각을 보이고, 서버가 다시 떠도 남음. 기기 목록도 끊긴 내 기기의 마지막 값을 보임', refs: ['REQ-F-807'] },
    ],
  },
  {
    version: '1.334',
    commit: 'fee4d4c',
    date: '2026-10-26',
    changes: [
      { kind: 'added', scope: ['agent', 'server', 'ui'], text: '기기별 배터리: 잔량, 충전 중·배터리 사용·전원 연결, 남은 시간, 사이클·최대 용량을 기기 목록·기기 화면·운영 페이지에 보임. 배터리 없는 기기는 "배터리 없음 · 전원 연결", 20% 이하로 전원 없이 쓰면 빨갛게', refs: ['REQ-F-806'] },
    ],
  },
  {
    version: '1.333',
    commit: '0f59814',
    date: '2026-10-25',
    changes: [
      { kind: 'changed', scope: ['ui'], text: '답의 선택지 글을 드래그로 골라 복사할 수 있음. 끌어서 글을 잡으면 보내지 않고, 그냥 누르거나 Enter·Space 는 그대로 보냄', refs: ['REQ-F-709'] },
    ],
  },
  {
    version: '1.332',
    commit: '900aff7',
    date: '2026-10-25',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '중간에 끊긴 턴이 일하는 중으로 남아 보낸 메시지가 붙잡히던 것: 화면이 비어 있고 1분 동안 아무것도 쓰이지 않으면 턴을 닫고, 끊겼다고 알리고, 붙잡힌 메시지를 보냄', refs: ['REQ-F-418'] },
    ],
  },
  {
    version: '1.331',
    commit: '8e73a21',
    date: '2026-10-25',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: 'Claude Code 의 "Try the new fullscreen renderer?" 권유 창이 보낸 지시문 줄까지 버튼으로 담긴 터미널 확인 카드가 되던 것: 창을 바르게 읽고, 일하는 도중에도 자동으로 "Not now" 로 넘김', refs: ['REQ-F-033'] },
    ],
  },
  {
    version: '1.330',
    commit: 'c7fa6e7',
    date: '2026-10-25',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '예전 키로 오는 탭이 하나 남아 있으면 에이전트가 10분마다 연동 페이지를 새 탭으로 열어 탭이 쌓이던 것: 연동 탭이 붙어 있으면 열지 않고, 같은 예전 키·브라우저로는 한 번만 엶', refs: ['REQ-S-065'] },
      { kind: 'fixed', scope: ['ui'], text: '중계가 에이전트에 다시 붙을 때마다 이 브라우저에 저장된 새 키를 다시 읽음: 다른 탭이 받은 새 키를 놓친 탭도 스스로 돌아옴', refs: ['REQ-S-065'] },
    ],
  },
  {
    version: '1.329',
    commit: '75c8253',
    date: '2026-10-25',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: 'EnterWorktree 로 worktree 에 들어간 세션이 그 worktree 의 연결된 세션으로 잡히지 않던 것: 훅의 지금 폴더(없으면 대화 기록 끝의 폴더)로도 이음', refs: ['REQ-F-805'] },
    ],
  },
  {
    version: '1.328',
    commit: '6336778',
    date: '2026-10-25',
    changes: [
      { kind: 'added', scope: ['agent', 'ui'], text: '머지된 worktree: 정리하면 얼마나 확보되는지 머리와 단추에 보이고, worktree 마다 연결된 세션이 살아 있는지·끝났는지 표시. 끝난 세션은 정리를 막지 않음', refs: ['REQ-F-805', 'REQ-F-802'] },
      { kind: 'added', scope: ['agent'], text: 'worktree 를 정리하면 그 세션 화면에 알림이 남고, 다시 열 때 빈 폴더에서 대화를 잇고 세션에게 worktree 가 머지·정리됐다고 시스템 프롬프트로 알림', refs: ['REQ-F-805'] },
    ],
  },
  {
    version: '1.327',
    commit: '77abe6f',
    date: '2026-10-25',
    changes: [
      { kind: 'added', scope: ['server', 'ui'], text: '디스크 정리 도움: 운영자가 다른 사용자의 기기에 정리 권한을 요청하고, 주인이 디스크 관리 메뉴에서 24시간 허용하면 그 운영자만 그 기기의 캐시·worktree·큰 폴더를 정리. 주인은 언제든 거두고, 요청·허용·운영자가 한 정리는 기기 기록에 남음', refs: ['REQ-F-804', 'IF-252', 'IF-251'] },
    ],
  },
  {
    version: '1.326',
    commit: '89b926e',
    date: '2026-10-25',
    changes: [
      { kind: 'added', scope: ['ui', 'server'], text: '디스크 관리 메뉴(/disk, 설정 → 더 보기): 모든 기기를 디스크가 많이 찬 순서로 한 목록에 보이고, 누르면 그 자리에서 캐시·머지된 worktree·큰 폴더를 관리. 기기 화면에는 이 메뉴로 가는 줄', refs: ['REQ-F-803'] },
    ],
  },
  {
    version: '1.325',
    commit: '260c48e',
    date: '2026-10-25',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '머지된 worktree 찾기가 검사하면서 index 를 다시 써서 모든 worktree 가 최근 1시간 안에 쓰인 것으로 보이던 것: 사용 시각을 먼저 읽고 git status 는 --no-optional-locks 로', refs: ['REQ-F-802'] },
    ],
  },
  {
    version: '1.324',
    commit: '5e6951b',
    date: '2026-10-25',
    changes: [
      { kind: 'added', scope: ['agent', 'server', 'ui'], text: '디스크 관리에 머지된 worktree 한 번에 정리: 기본 브랜치에 머지됐고 고친 것이 없고 열린 세션·최근 1시간 사용이 없는 worktree 를 찾아 git worktree remove 와 머지된 브랜치 지우기를 한 번에', refs: ['REQ-F-802', 'IF-251'] },
    ],
  },
  {
    version: '1.323',
    commit: 'd99953c',
    date: '2026-10-25',
    changes: [
      { kind: 'added', scope: ['agent', 'server', 'ui'], text: '디스크 관리: 기기 화면에서 다시 만들어지는 캐시(npm·Yarn·pnpm·Homebrew·Go·pip·Playwright·Xcode·시뮬레이터)와 휴지통을 크기와 함께 보고 비우고, 홈 폴더를 크기순으로 열어 큰 항목을 휴지통으로 옮김. 설정·비밀값 폴더, macOS 보호 폴더, 열린 세션 폴더는 막음. 기기 주인만', refs: ['REQ-F-801', 'IF-251'] },
    ],
  },
  {
    version: '1.322',
    commit: '892d3e5',
    date: '2026-10-25',
    changes: [
      { kind: 'added', scope: ['agent', 'server', 'ui'], text: '기기의 CPU·메모리·디스크 사용률: 기기 화면과 운영 페이지 기기 줄에 CPU %, 쓰는 메모리 / 전체, 디스크 % 와 남은 공간. macOS 메모리는 활성 상태 보기와 같은 셈', refs: ['REQ-F-800'] },
    ],
  },
  {
    version: '1.321',
    commit: '417e10f',
    date: '2026-10-25',
    changes: [
      { kind: 'added', scope: ['agent', 'server', 'ui'], text: '키 교체 기록: 기기마다 최근 5번의 키 교체(자동·사이트·옛 세대)와 연동 탭이 새 키로 온 시각을 서버로 알리고, 운영 페이지 키 줄에 마지막 교체 결과를 보임. 탭이 끝내 오지 않으면 키 확인 배지와 점검 경고', refs: ['REQ-S-084'] },
    ],
  },
  {
    version: '1.320',
    commit: 'f0facd7',
    date: '2026-10-25',
    changes: [
      { kind: 'added', scope: ['server'], text: '서비스 API: 믿을 수 있는 서버(예: 자동 수정)가 쿠키 대신 Bearer 토큰(BRIDGE_SERVICE_TOKEN, 32자 이상)으로 정해진 한 사람(BRIDGE_SERVICE_UID)의 맥에 무인 세션(안전한 전부 허용)을 열고, 자기가 연 세션의 상태·답만 읽음. 두 환경변수가 없으면 꺼짐', refs: ['REQ-F-799', 'IF-249', 'IF-250', 'ERR-340', 'ERR-341', 'ERR-342', 'ERR-343', 'ERR-344'] },
    ],
  },
  {
    version: '1.319',
    commit: 'e21986d',
    date: '2026-10-25',
    changes: [
      { kind: 'security', scope: ['agent'], text: '에이전트 연동 키가 하루마다 스스로 바뀐다. 연동 탭이 지금 키로 붙어 있을 때만 바꾸고, 이전 키는 15분 더 통한다', refs: ['REQ-S-083'] },
      { kind: 'changed', scope: ['ui'], text: '운영 페이지 기기 키 줄에 다음 자동 교체까지 남은 시간', refs: ['REQ-S-083'] },
    ],
  },
  {
    version: '1.318',
    commit: '28f1e8a',
    date: '2026-10-25',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '키를 바꾼 직후 헤드리스 Chrome 을 다시 띄우면 옛 키로 붙어 15분 뒤 끊길 수 있던 것: 헤드리스 Chrome 은 늘 현재 키로 뜨고, 예전 키로 오면 에이전트가 다시 띄움', refs: ['REQ-S-081', 'REQ-F-277'] },
    ],
  },
  {
    version: '1.317',
    commit: 'c25d93c',
    date: '2026-10-25',
    changes: [
      { kind: 'security', scope: ['server'], text: 'https 사이트의 모든 응답에 Strict-Transport-Security(max-age 1년, 하위 도메인 제외): 첫 접속이나 http:// 로 친 주소도 브라우저가 https 로만 오게', refs: ['REQ-S-082'] },
      { kind: 'security', scope: ['server'], text: "페이지 CSP 에 base-uri 'self'·object-src 'none' 을 더함", refs: ['REQ-S-011'] },
      { kind: 'security', scope: ['server'], text: '데모 계정의 :sudo·/root 글 막기가 글 앞의 유니코드 공백(U+3000 등)으로 지나가던 것: JavaScript 와 같은 공백 규칙으로 막음', refs: ['REQ-S-068'] },
    ],
  },
  {
    version: '1.316',
    commit: '9b0357f',
    date: '2026-10-25',
    changes: [
      { kind: 'security', scope: ['agent'], text: '헤드리스 Chrome 명령줄(ps 로 누구나 보임)에 연동 키 대신 에이전트의 한 번 쓰는 주소(127.0.0.1/bg-open, 2분)를 싣고, 에이전트가 키가 든 연동 주소로 넘김', refs: ['REQ-S-081', 'REQ-F-277'] },
      { kind: 'security', scope: ['agent', 'server'], text: '사이트로 가는 대화·도구 출력·로그에서 연동 키(#…&key=…, x-bridge-key, 이 기기의 키 값)를 *** 로 가림. 서버도 저장하기 전에 가려 옛 에이전트 것까지 막음', refs: ['REQ-S-081'] },
    ],
  },
  {
    version: '1.315',
    commit: '2d8b7d0',
    date: '2026-10-25',
    changes: [
      { kind: 'added', scope: ['agent'], text: 'Linux x86_64 에서도 zeropty 0.1.6 을 받아 새 세션을 zeropty 에서 엶(고정 주소·SHA-256, preload shim.so). tmux 는 대비가 되고, 설치 스크립트는 tmux 가 없어도 멈추지 않음', refs: ['REQ-F-798', 'REQ-F-794'] },
      { kind: 'changed', scope: ['agent'], text: '점검의 claude 로그인 안내를 "이 맥의 터미널" 대신 "이 기기의 터미널"로', refs: ['REQ-F-798'] },
    ],
  },
  {
    version: '1.314',
    commit: 'a76e7dc',
    date: '2026-10-25',
    changes: [
      { kind: 'added', scope: ['agent'], text: 'Linux(systemd) 호스트: 설치 스크립트가 Linux 를 받고, node 가 없으면 Node.js 22 를 ~/.claude-bridge/node 에 받음(SHA-256 확인, root 불필요). 백그라운드 서비스는 systemd 사용자 서비스(Restart=always, KillMode=process), linger 가 꺼져 있으면 안내. 기기 종류 서버', refs: ['REQ-F-798', 'CON-006', 'CON-011'] },
      { kind: 'added', scope: ['agent', 'server', 'ui'], text: '화면 없는 기기 연결: 기기 화면에서 만든 로그인 주소(5분·한 번)를 그 기기 터미널에서 `agent.mjs headless` 로 넘기면 헤드리스 연동 모드가 켜지고 Chrome·Chromium 이 로그인해 연결', refs: ['REQ-F-798', 'IF-007', 'IF-164'] },
      { kind: 'security', scope: ['server'], text: '화면 없는 기기용 로그인 주소는 헤드리스 브라우저(UA HeadlessChrome)만 로그인되고, 보통 브라우저는 안내만 봄(남이 만든 주소로 내 맥이 그 계정에 붙지 않게)', refs: ['REQ-F-798', 'IF-007'] },
      { kind: 'changed', scope: ['agent', 'ui'], text: 'Linux 에서는 잠자기 막기·덮개·macOS 허락 창 감시를 하지 않고 기기 화면에 그렇다고 표시. zeropty 는 시스템별 판을 두고, Linux 판이 나오기 전까지 Linux 세션은 tmux', refs: ['REQ-F-798', 'REQ-F-794'] },
    ],
  },
  {
    version: '1.313',
    commit: '5f6571e',
    date: '2026-10-25',
    changes: [
      { kind: 'added', scope: ['server'], text: '권한 요청 푸시 알림에 허용·거부 버튼: 알림에서 바로 답한다(그 카드가 아직 열려 있을 때만 눌림). Safari·iOS 웹 앱은 버튼 없이 예전처럼 누르면 세션이 열림', refs: ['REQ-F-797', 'IF-018'] },
    ],
  },
  {
    version: '1.312',
    commit: 'f9101f2',
    date: '2026-10-25',
    changes: [
      { kind: 'added', scope: ['ui', 'server', 'agent'], text: '권한 모드에 빨간 "전부 허용"을 더함: 위험한 호출(폴더 밖 삭제·강제 push·sudo·비밀 파일)까지 묻지 않고 바로 허용. 세션 칩·선택칸·목록의 점이 빨갛게 보임', refs: ['REQ-F-796'] },
      { kind: 'changed', scope: ['ui', 'server', 'agent'], text: '지금까지의 전부 허용은 "안전한 전부 허용"으로 이름을 바꿈(위험한 호출만 물음). 복제·가벼운 복제는 원래 세션의 전부 허용을 그대로 잇고, 맡긴 세션·맥 옮기기도 같은 정책으로', refs: ['REQ-F-796', 'REQ-F-760'] },
    ],
  },
  {
    version: '1.311',
    date: '2026-10-25',
    commit: 'abe1f06',
    changes: [
      { kind: 'changed', scope: ['server'], text: '권한 허용이 필요하면 푸시 알림에 어느 세션(제목)·어느 맥·무슨 호출(예: Bash: git push origin main)인지 담아 보내고, 조작 페이지가 다른 기기에서 앞에 떠 있어도 보냄. 5·10분 다시 알리기도 같은 형식', refs: ['REQ-F-795', 'REQ-F-482', 'REQ-F-483', 'REQ-F-517'] },
      { kind: 'removed', scope: ['server'], text: '백그라운드 작업이 끝났을 때의 푸시 알림: 알림 목록에만 남김', refs: ['REQ-F-519'] },
    ],
  },
  {
    version: '1.310',
    commit: '1cbcec7',
    date: '2026-10-25',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: '세션 입력칸이 여러 줄이 돼도 한 줄 높이에 머물던 것: 글에 맞춰 늘어나고, 창 높이의 30% 안에 드는 줄 수까지 커진 뒤로는 상자 안에서 스크롤', refs: ['REQ-F-150'] },
    ],
  },
  {
    version: '1.309',
    commit: 'd6f3c1e',
    date: '2026-10-23',
    changes: [
      { kind: 'changed', scope: ['server'], text: '서버를 Node 에서 Go 로 다시 작성: 표준 라이브러리만 쓰는 바이너리 하나. 경로·메시지·쿠키·플러그인 API·데이터 파일 형식·환경 변수·포트·오류 문구는 그대로이고, 실행 이미지에 node 가 없음(HEALTHCHECK 는 wget). JSON 키 순서와 압축(gzip 만)만 달라짐', refs: ['REQ-M-016', 'CON-014', 'CON-015'] },
    ],
  },
  {
    version: '1.308',
    commit: '577c7f6',
    date: '2026-10-21',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '답을 쓰는 동안 미리보기에서 코드블록 줄이 한 줄로 합쳐지던 것(`return a + b; }`): 화면 폭 때문에 접힌 줄만 잇도록 폭 검사를 바로잡고, Claude Code 가 코드에 쓰는 색(문법 강조 16색, 언어 없는 블록은 줄 전체 코드 색)으로 코드블록을 알아봐 잇지 않고 들여쓰기 그대로 코드로 보임', refs: ['REQ-F-036'] },
      { kind: 'fixed', scope: ['agent'], text: '쓰는 중인 긴 문단이 화면 폭에서 접힌 그대로 여러 줄로 보이던 것: 한 문단으로 이어 보임', refs: ['REQ-F-036'] },
    ],
  },
  {
    version: '1.307',
    commit: '45f9a22',
    date: '2026-10-21',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '다시 여는 중(기본 프롬프트 변경·새로고침 등)에 세션을 지우면 맥에 zeropty·tmux 세션이 남던 것: 지우기가 먼저 닫힘을 표시하고, 다시 열기는 그 표시를 보면 멈추며 이미 띄운 터미널을 스스로 끝냄', refs: ['REQ-F-400', 'REQ-F-377'] },
    ],
  },
  {
    version: '1.306',
    commit: '30290c7',
    date: '2026-10-21',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: '세션 파일 게이지 시험(AC-1159)을 넓은 화면 접기(1.249)에 맞춤: 작은 SESSION.md 게이지는 "+n" 안에 있고 펼친 뒤 누르면 시트, AGENTS.md 는 ⋯ 메뉴. 화면 동작은 그대로', refs: ['REQ-F-147', 'REQ-F-149'] },
    ],
  },
  {
    version: '1.305',
    commit: '383a1b0',
    date: '2026-10-21',
    changes: [
      { kind: 'changed', scope: ['agent'], text: '세션 터미널을 tmux 에서 zeropty 로: 에이전트가 켜질 때 zeropty 0.1.3 을 GitHub 릴리스에서 받아, 에이전트 코드에 고정된 SHA-256 이 맞을 때만 ~/.claude-bridge/zeropty/0.1.3 에 설치(맞지 않거나 못 받으면 설치하지 않고 tmux, 30분 뒤 다시). 그 뒤 새로 여는 세션부터 zeropty 에서 돌고, 이미 tmux 에서 돌던 세션은 닫거나 다시 열 때까지 tmux 로 이어 다룸', refs: ['REQ-F-794'] },
      { kind: 'added', scope: ['agent'], text: 'zeropty 를 쓰면 처음 세션을 띄울 때 서명을 바꾼 claude 사본이 홈의 ~/.zeropty/tty 에 생김(claude 한 벌, 약 260MB)과 소켓 ~/.zeropty/mux.sock. 원치 않으면 `node ~/.claude-bridge/agent.mjs service install --mux tmux` 로 새 세션도 tmux 로(`--mux auto` 로 되돌림)', refs: ['REQ-F-794', 'IF-164'] },
      { kind: 'changed', scope: ['agent'], text: '설치 스크립트와 점검에서 tmux 는 필수가 아니라 zeropty 가 안 될 때의 대비. 점검에 zeropty 항목', refs: ['REQ-F-794'] },
      { kind: 'added', scope: ['ui', 'server'], text: '호스트 화면에 에이전트의 zeropty 버전과 세션마다 터미널(zeropty·tmux)', refs: ['REQ-F-794'] },
    ],
  },
  {
    version: '1.304',
    commit: '2e0a44f',
    date: '2026-10-20',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '대화 기록 정리를 한 세션에서, 연동이 다시 붙은 뒤 Claude 의 답이 화면에 안 오던 것: 덜어 낸 줄 수(lineBase)를 기억해 다시 읽을 때 줄 번호를 서버와 맞춤. 이미 이렇게 된 세션은 파일 끝까지 읽은 뒤 서버 줄 수에 맞춰 다음 답부터 다시 옴', refs: ['REQ-F-793'] },
    ],
  },
  {
    version: '1.303',
    commit: '6947abe',
    date: '2026-10-20',
    changes: [
      { kind: 'fixed', scope: ['server'], text: '웹 검색을 한 답처럼 ```choices 블록 뒤에 Sources 목록이 붙어도 선택지 버튼이 나옴. 출처 목록은 답 글 끝에 남음', refs: ['REQ-F-579'] },
    ],
  },
  {
    version: '1.302',
    commit: '9037e3e',
    date: '2026-10-19',
    changes: [
      { kind: 'added', scope: ['ui', 'server', 'agent'], text: '"대화 기록 정리"(세션 메뉴의 가벼운 복제 아래, 100MB 띠): 압축한 세션의 .jsonl 에서 마지막 압축 앞부분을 덜어 내고(원본은 맥의 ~/.claude-bridge/trimmed/) 같은 세션으로 다시 열어 100MB 입력 막힘을 새 세션 없이 푼다', refs: ['REQ-F-793', 'IF-248', 'ERR-338', 'ERR-339'] },
      { kind: 'changed', scope: ['server'], text: '100MB 입력 막힘 문구가 대화 기록 정리도 알려 줌', refs: ['REQ-P-129', 'ERR-062'] },
    ],
  },
  {
    version: '1.301',
    commit: '7ed355b',
    date: '2026-10-19',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: '압축해도 대화 기록(.jsonl) 100MB 입력 막힘이 풀리지 않던 것: 기록이 90MB 를 넘으면 압축 띠 대신 "압축은 기록 파일을 줄이지 않아요" 안내와 가벼운 복제 버튼', refs: ['REQ-F-776', 'REQ-P-129'] },
    ],
  },
  {
    version: '1.300',
    commit: '7201e3e',
    date: '2026-10-19',
    changes: [
      { kind: 'added', scope: ['ui'], text: '세션 메뉴(목록 길게 누르기·⋯)에 "지금 압축": 컨텍스트 크기와 상관없이 쉬는 세션의 대화를 요약해 그 세션에서 그대로 이어감. 폰에서도 원할 때 대화를 정리할 수 있게', refs: ['REQ-F-776'] },
    ],
  },
  {
    version: '1.299',
    commit: 'df52c8c',
    date: '2026-10-19',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: '세션 목록에서 길게 누르거나 오른쪽 클릭한 메뉴에도 "할 일 정리". 폰에서 목록 메뉴로는 찾을 수 없었음', refs: ['REQ-F-778'] },
    ],
  },
  {
    version: '1.298',
    commit: '1f6ed7d',
    date: '2026-10-19',
    changes: [
      { kind: 'security', scope: ['server'], text: '로그인 쿠키를 __Host-cb(·__Host-cb_state·__Host-cb_apple)로: 미리보기 출처 같은 다른 하위 도메인이 쿠키를 심어 다른 계정으로 로그인시킬 수 없게. 옛 cb 로그인은 2026-11-02 까지 로그아웃 없이 새 이름으로 옮기고, __Host-cb 가 있으면 옛 cb 는 무시하고 지움', refs: ['REQ-S-080'] },
    ],
  },
  {
    version: '1.297',
    commit: 'dc3c647',
    date: '2026-10-19',
    changes: [
      { kind: 'security', scope: ['server'], text: '스킬 저장소의 marketplace.json 경로(pluginRoot·source·name)가 GitHub API 주소에 그대로 붙어 서버 토큰을 다른 저장소에 쓸 수 있던 것: 평범한 경로 조각만 받고, 주소가 그 저장소 밖이면 그 스킬을 건너뜀', refs: ['REQ-S-076', 'REQ-F-792'] },
      { kind: 'security', scope: ['server'], text: '이름이 바뀌었거나 옮겨진 스킬 저장소(GitHub 301)를 따라가지 않음. /skills 에 "저장소를 찾을 수 없어요"', refs: ['REQ-S-077'] },
      { kind: 'security', scope: ['server', 'ui'], text: '/skills/install.sh 는 서버가 서명한 주소(?repo=…&t=…)로만 받음. 서명은 /api/skills 가 그 저장소를 쓰는 사람에게만 주고, 아니면 404. 설치 명령도 그 주소로', refs: ['REQ-S-078', 'REQ-F-792'] },
      { kind: 'security', scope: ['server', 'ui'], text: '/api/health 는 ok·version·instance 만. BRIDGE_ORIGIN 유무·root 실행·에이전트 서명 상태는 운영 화면(/api/admin/overview)으로', refs: ['REQ-S-079', 'IF-039', 'IF-033'] },
    ],
  },
  {
    version: '1.296',
    commit: 'ab78491',
    date: '2026-10-19',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: 'iPhone 앱에서 키보드를 띄우면 머리 막대가 위로 34 px 밀려 잘리고 입력 상자 아래 줄이 잘리던 것: 입력창을 쓰는 동안은 iOS 의 밀어 올림을 되돌리고 입력창을 키보드 위로 직접 올림', refs: ['REQ-F-757'] },
    ],
  },
  {
    version: '1.295',
    commit: '00e692b',
    date: '2026-10-19',
    changes: [
      { kind: 'changed', scope: ['server', 'ui'], text: '스킬 저장소를 사람마다: 설정 → 더 보기 → 스킬 저장소에 내 GitHub 저장소(owner/repo)를 넣으면 /skills 가 그걸 읽음. SKILLS_REPO 는 설정하지 않은 사람의 기본값', refs: ['REQ-F-792', 'IF-247'] },
      { kind: 'security', scope: ['server'], text: '스킬 저장소는 owner 가 내 GitHub 로그인과 같을 때만 저장(아니면 400). Apple·데모 계정은 못 정함. 남의 저장소 목록은 보이지 않음', refs: ['REQ-F-792'] },
      { kind: 'security', scope: ['server'], text: '로그인 없이 열리는 /skills/version 은 코드 해시만. 저장소 이름·커밋·개수는 로그인한 사람의 자기 저장소일 때만', refs: ['REQ-F-290'] },
      { kind: 'changed', scope: ['server'], text: '/skills/install.sh?repo=owner/repo 로 저장소마다. 누군가 정한 저장소가 아니면 404. 설치 명령도 그 주소로', refs: ['REQ-F-792'] },
      { kind: 'removed', scope: ['ui', 'server'], text: '운영 탭의 스킬 저장소 칸과 /api/admin/skills. 예전 서버 하나의 값은 시작할 때 그 저장소 주인 계정의 설정으로 옮김', refs: ['IF-246'] },
    ],
  },
  {
    version: '1.294',
    commit: 'fe5168e',
    date: '2026-10-19',
    changes: [
      { kind: 'changed', scope: ['server'], text: '리포를 CreatiCoding/agent-bridge 로 옮기고 소스 코드 링크를 새 주소로. 1.293 이전 커밋 해시는 비공개로 보관한 옛 리포에만 있음', refs: ['REQ-F-791'] },
    ],
  },
  {
    version: '1.293',
    commit: '37f88f2',
    date: '2026-10-19',
    changes: [
      { kind: 'changed', scope: ['ui'], text: "TestFlight 빌드 번호를 커밋 수 대신 2026-01-01 UTC 부터 지난 분으로(지난번보다 항상 큼). 히스토리를 합쳐도 번호가 내려가지 않음", refs: ['REQ-F-762', 'REQ-F-781'] },
    ],
  },
  {
    version: '1.292',
    commit: '9316146',
    date: '2026-10-19',
    changes: [
      { kind: 'security', scope: ['agent'], text: "에이전트가 믿는 서명 공개키를 agent/keys.mjs 로 뺌. 서명되는 파일이라 서버가 바꿀 수 없고, 포크는 sign-agent.mjs --init 으로 자기 키를 만듦", refs: ['REQ-S-067', 'REQ-M-005'] },
    ],
  },
  {
    version: '1.291',
    commit: 'f8d7c93',
    date: '2026-10-19',
    changes: [
      { kind: 'changed', scope: ['server'], text: "공개 데모를 기본으로 끔: BRIDGE_DEMO=1 일 때만 로그인 화면에 데모로 둘러보기가 보임", refs: ['REQ-F-766', 'IF-222'] },
    ],
  },
  {
    version: '1.290',
    commit: 'a024bf3',
    date: '2026-10-19',
    changes: [
      { kind: 'changed', scope: ['server', 'ui'], text: "스킬 저장소 기본값을 없애고, 운영자가 설정 → 운영 → 스킬 저장소에서 owner/repo 를 넣고 바꾸게 함(환경 변수 SKILLS_REPO 가 있으면 그게 우선)", refs: ['REQ-F-792', 'IF-246'] },
    ],
  },
  {
    version: '1.289',
    commit: '3693975',
    date: '2026-10-19',
    changes: [
      { kind: 'added', scope: ['server', 'ui'], text: "라이선스를 AGPL-3.0 으로 정하고, 로그인 화면·지원 페이지 꼬리말과 설정 → 더 보기에 소스 코드 링크를 더함(주소는 BRIDGE_SOURCE_URL)", refs: ['REQ-F-791', 'REQ-M-008', 'IF-008'] },
    ],
  },
  {
    version: '1.288',
    commit: 'a0186b9',
    date: '2026-10-19',
    changes: [
      { kind: 'fixed', scope: ['server'], text: '개인정보 처리방침 영어 요약의 보호책임자 이름 표기를 Jeong Seokho 로 고침', refs: ['REQ-F-767'] },
    ],
  },
  {
    version: '1.287',
    commit: '7492117',
    date: '2026-10-19',
    changes: [
      { kind: 'changed', scope: ['server'], text: '개인정보 처리방침에 보호책임자 성명을 적고, 이전 판에서 저장된 대화를 서버에서 모두 지웠음을 적음', refs: ['REQ-F-767'] },
    ],
  },
  {
    version: '1.286',
    commit: 'a7cdb04',
    date: '2026-10-19',
    changes: [
      { kind: 'added', scope: ['ui', 'server'], text: '분할 조합 순서 바꾸기: 조합 메뉴의 "위로 옮기기·아래로 옮기기"로 목록과 조합 메뉴의 순서를 바꿈', refs: ['REQ-F-790', 'IF-245'] },
    ],
  },
  {
    version: '1.285',
    commit: '97a9bb6',
    date: '2026-10-19',
    changes: [
      { kind: 'added', scope: ['ui', 'server'], text: '분할 조합: 분할 화면 막대의 "조합"에서 지금 칸들을 이름 붙여 저장하고, 저장한 조합을 다시 연다. 넓은 화면의 세션 목록 맨 위에서도 연다. 계정에 저장돼 모든 기기에 보인다', refs: ['REQ-F-790'] },
    ],
  },
  {
    version: '1.284',
    commit: '41f02c0',
    date: '2026-10-18',
    changes: [
      { kind: 'changed', scope: ['server'], text: '개인정보 처리방침: 문제 제보의 AI 도구 처리는 제3조의 한 줄로만 적고 제7조의 Anthropic 이전 카드를 뺌. 영어 요약에서 AI 도구 이름과 서버에 더 없는 pictures 를 뺌', refs: ['REQ-F-767'] },
    ],
  },
  {
    version: '1.283',
    commit: '8d49747',
    date: '2026-10-18',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '맥의 받아쓰기 모델에 "전송·리셋"을 미리 알려 줌(프롬프트 맨 끝): 혼자 말한 명령이 순종·전성·천송·리스트로 나오던 것을 줄임', refs: ['REQ-F-789'] },
    ],
  },
  {
    version: '1.282',
    date: '2026-10-18',
    commit: '081a60f',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: '혼자 말한 짧은 낱말이 전송·리셋과 자모 하나 차이거나 자주 잘못 나오는 말(순종, 리스트)이면 그 명령으로 봄. 긴 말 속에서는 글', refs: ['REQ-F-789'] },
    ],
  },
  {
    version: '1.281',
    date: '2026-10-18',
    commit: '3e431da',
    changes: [
      { kind: 'added', scope: ['ui'], text: '음성 명령: 한 마디 맨 앞에 "두 번째 세션"처럼 칸 이름을 말하면 그 칸으로 옮겨 쌓고, 맨 끝에 "전송"이면 보내고 "리셋"이면 모은 말을 지움. 다른 자리의 같은 말은 글', refs: ['REQ-F-789'] },
    ],
  },
  {
    version: '1.280',
    date: '2026-10-18',
    commit: '8c1ecdb',
    changes: [
      { kind: 'added', scope: ['ui'], text: '분할 화면에서 음성 모드를 함께 씀: 한 칸에서 켜면 모든 칸이 켜지고, 말은 받는 칸 하나에 쌓여 그 칸의 전송으로 보냄. 다른 칸의 "여기로 받기"로 받는 칸을 바꾸고, 어디서 끄든 다 꺼짐', refs: ['REQ-F-788'] },
    ],
  },
  {
    version: '1.279',
    date: '2026-10-18',
    commit: '4988e9d',
    changes: [
      { kind: 'changed', scope: ['server'], text: '개인정보 처리방침: 서버가 세션의 대화를 저장하지 않고 전달만 함, 세션 정보는 제목·미리보기 80자·상태·맥·작업 폴더·PR 링크·통계 숫자만, 예전에 저장된 대화는 맥으로 옮긴 뒤 확인을 거쳐 삭제', refs: ['REQ-F-767', 'REQ-M-018'] },
      { kind: 'changed', scope: ['server'], text: '개인정보 처리방침: 문제 제보가 운영자의 AI 도구로 처리될 수 있음과 그 국외 이전(Anthropic, 미국)을 적음', refs: ['REQ-F-767'] },
      { kind: 'changed', scope: ['ui'], text: '계정 삭제 창: 서버에서 지우는 것을 세션 정보·보낸 영상·예전 대화 기록으로, 지우지 않는 것에 맥의 화면 기록', refs: ['REQ-F-770'] },
    ],
  },
  {
    version: '1.278',
    date: '2026-10-18',
    commit: 'dcdca29',
    changes: [
      { kind: 'changed', scope: ['ui'], text: 'iPad 에서는 Enter 로 보내고 Shift+Enter 로 줄바꿈(PC 와 같게). 폰은 그대로 Enter 가 줄바꿈', refs: ['REQ-F-075'] },
    ],
  },
  {
    version: '1.277',
    date: '2026-10-18',
    commit: '3cc4c9f',
    changes: [
      { kind: 'security', scope: ['server'], text: '서버가 대화 사본·화면 기록·그림을 더 저장하지 않음. 화면은 맥에 물어 받고, 서버는 최근 기록 일부만 메모리에 둠', refs: ['REQ-S-069'] },
      { kind: 'added', scope: ['ui'], text: '세션의 맥이 끊겨 있으면 대화 위에 "맥 연결 끊김" 띠, 이 기기에 남은 대화만 보이고 10초마다 다시 물음', refs: ['REQ-F-787'] },
      { kind: 'changed', scope: ['server', 'agent'], text: '다른 맥으로 옮기기는 보내는 맥에서 대화와 기록을 받아 넘김. 보내는 맥이 꺼져 있으면 옮길 수 없음("전환" 버튼 없앰)', refs: ['REQ-S-069', 'IF-242'] },
      { kind: 'changed', scope: ['server', 'agent'], text: '통계는 맥이 보낸 숫자로만 셈, 턴이 끝나면 5초 안에 갱신', refs: ['REQ-S-070', 'IF-238'] },
      { kind: 'security', scope: ['server'], text: '잠근 세션은 미리보기와 손으로 붙이지 않은 제목을 저장하지 않음, 미리보기 80자, 마지막 글·맥 그림 경로 저장 안 함', refs: ['REQ-S-070'] },
      { kind: 'changed', scope: ['server'], text: '운영자 정리에서 대화 파일(사본·기록·그림)을 고를 수 있게 됨(여전히 BRIDGE_PURGE=1 일 때만, 맥으로 옮기지 않은 기록은 남김)', refs: ['REQ-S-075'] },
    ],
  },
  {
    version: '1.276',
    date: '2026-10-18',
    commit: 'cd7ed5e',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: 'iPad 에서 화면 키보드가 뜨면 입력창이 키보드 뒤에 가려지던 것: 키보드가 가린 만큼 입력창을 올림. 분할 화면의 칸에서도', refs: ['REQ-F-757'] },
    ],
  },
  {
    version: '1.275',
    date: '2026-10-18',
    commit: '0fe4eb0',
    changes: [
      { kind: 'added', scope: ['ui'], text: '분할 화면: 세션 ⋯ 메뉴 "분할로 띄우기"로 세션을 골라 최대 3개를 폰 폭 칸으로 나란히 띄움(iPad 가로 3칸·세로 2칸). 칸마다 따로 보내고, 칸 메뉴로 추가·빼기·크게 보기. 데모에서도 됨', refs: ['REQ-F-786'] },
      { kind: 'added', scope: ['ui'], text: 'iOS 앱이 iPad 에서 전체 화면으로 뜨고 세로·가로를 모두 지원', refs: ['REQ-F-756'] },
      { kind: 'changed', scope: ['ui'], text: '넓은 화면 기준을 900 px → 744 px 로: iPad 세로에서도 목록과 대화가 나란히 보임', refs: ['REQ-F-786'] },
      { kind: 'security', scope: ['server'], text: "CSP frame-ancestors 를 'none' → 'self' 로(같은 사이트의 분할 칸만 허용, 다른 사이트는 계속 막음)", refs: ['REQ-S-011'] },
    ],
  },
  {
    version: '1.274',
    date: '2026-10-18',
    commit: '0814ff1',
    changes: [
      { kind: 'added', scope: ['ui', 'server'], text: '세션 ⋯ 메뉴 "작업 폴더 바꾸기": 같은 맥의 다른 폴더(또는 새 기본 폴더)에서 같은 대화를 이어서 엶. 없는 폴더는 물어보고 만듦', refs: ['REQ-F-785', 'IF-241', 'ERR-337'] },
    ],
  },
  {
    version: '1.273',
    date: '2026-10-18',
    commit: 'd41affd',
    changes: [
      { kind: 'added', scope: ['agent', 'server'], text: '맥 에이전트가 세션 기록과 그림을 맥에 받아 둠(서버에 있던 것도 맥으로 옮김). 서버가 대화를 저장하지 않게 하는 준비, 화면은 그대로', refs: ['REQ-S-069'] },
      { kind: 'added', scope: ['agent', 'server'], text: '통계 숫자와 대화에 나온 PR 링크를 맥이 계산해 보냄', refs: ['REQ-S-070'] },
      { kind: 'security', scope: ['server'], text: '세션 상태 방송에서 통계 숫자·PR 링크·옛 지침 본문을 뺌', refs: ['REQ-S-070'] },
    ],
  },
  {
    version: '1.272',
    date: '2026-10-18',
    commit: '4fea9a3',
    changes: [
      { kind: 'changed', scope: ['server'], text: '알림 내역은 30일 동안 두고 자동으로 지움. 잠긴 세션의 알림은 이름 없이 "확인할 것이 있어요"만, 세션을 지우면 그 알림도 지움', refs: ['REQ-S-071', 'REQ-S-063'] },
      { kind: 'changed', scope: ['server', 'ui'], text: '문제 제보는 90일 뒤 자동으로 지우고(그림·영상 함께), 계정을 지워도 그동안 남음. 제보 화면과 계정 삭제 창에 안내', refs: ['REQ-S-072', 'REQ-F-770'] },
      { kind: 'changed', scope: ['server'], text: '대기·거절된 접근 요청은 마지막 시도 90일 뒤 지움', refs: ['REQ-S-074'] },
      { kind: 'added', scope: ['server'], text: '운영자 전용 기존 데이터 정리: 대상 수·크기를 보고, BRIDGE_PURGE=1 일 때만 지움', refs: ['REQ-S-075'] },
    ],
  },
  {
    version: '1.271',
    date: '2026-10-18',
    commit: '0d8621c',
    changes: [
      { kind: 'security', scope: ['agent', 'server'], text: 'git 원격 주소의 인증 정보(user:token@, x-access-token, ssh 비밀번호)를 맥과 서버 양쪽에서 지워 저장·로그에 남기지 않음', refs: ['REQ-S-073'] },
      { kind: 'security', scope: ['server'], text: '작업 폴더의 지침 파일(SESSION·AGENTS·CLAUDE.md) 본문을 서버에 저장하지 않음, 옮길 때 보내는 맥에서 받음', refs: ['REQ-S-073'] },
      { kind: 'security', scope: ['server', 'agent'], text: '서버 로그에서 IP·요청 쿼리·맥 로그 본문을 빼고, 맥의 Claude 계정 이메일·요금제·hostname 을 저장하지 않음', refs: ['REQ-S-074'] },
      { kind: 'changed', scope: ['server'], text: '보낸 영상은 맥이 받으면 바로, 만료된 로그인 토큰 해시는 1시간 안에 지움', refs: ['REQ-S-074'] },
    ],
  },
  {
    version: '1.270',
    date: '2026-10-18',
    commit: '3acdbd3',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server'],
        text: '할 일 항목을 직접 뺀다. 항목 오른쪽 × 로 빼면 세션에 저장돼 다른 기기에서도, Claude 가 같은 일을 다시 보내도 빠진 채이고, 알림의 "되돌리기"로 다시 보인다',
        refs: ['REQ-F-784', 'IF-067'],
      },
    ],
  },
  {
    version: '1.269',
    date: '2026-10-18',
    commit: 'f8b5763',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: 'PC 맨 왼쪽 앱 레일의 새 세션(+)·검색 버튼이 목록 위 검색칸·+ 와 겹치던 것. 목록이 펼쳐져 있으면 레일에서 빼고, 목록을 접었을 때만 보인다',
        refs: ['REQ-F-715'],
      },
    ],
  },
  {
    version: '1.268',
    date: '2026-10-18',
    commit: '1cf8fde',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: '답한 권한 카드가 "Do you want to proceed? · 허용"만 남아 무엇을 허락했는지 알 수 없던 것. 이제 닫힌 카드도 명령·파일 내용을 보인다. 알림 줄의 *전부 허용*이지만 처럼 별표 뒤에 글자가 붙은 강조도 굵게 그린다',
        refs: ['REQ-F-591', 'REQ-F-592'],
      },
    ],
  },
  {
    version: '1.267',
    date: '2026-10-18',
    commit: '134e08f',
    changes: [
      {
        kind: 'changed',
        scope: ['server'],
        text: '개인정보 처리방침 /privacy 를 "합니다"체의 공식 문서로: 개인정보 보호법 제30조·시행령 제31조의 기재 사항을 제1조~제15조(처리 목적, 항목, 보유 기간, 파기, 제3자 제공, 위탁, 국외 이전, 민감정보, 정보주체의 권리, 안전성 확보 조치, 쿠키, 보호책임자, 열람청구, 권익침해 구제, 변경)로 나누고 목차를 단다. 저장 항목·보관 기간·삭제 방법은 그대로',
        refs: ['REQ-F-767'],
      },
    ],
  },
  {
    version: '1.266',
    date: '2026-10-18',
    commit: '8dc4c24',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: 'Claude 가 남은 일만 담아 할 일을 다시 보내면 앞서 완료한 항목이 패널에서 모두 사라지던 것. 이제 새 목록에 없는 완료 항목은 완료로 남는다(빈 목록은 여전히 비움). "다시 정리" 부탁에도 완료 항목을 그대로 넣어 보내 달라고 적는다',
        refs: ['REQ-F-778'],
      },
    ],
  },
  {
    version: '1.265',
    date: '2026-10-18',
    commit: 'c58ff59',
    changes: [
      {
        kind: 'added',
        scope: ['server'],
        text: '지원 페이지 /support: 로그인 없이 열리고, 시작 방법·자주 묻는 것(맥 연결, 앱 알림, 업데이트, 계정 삭제)·문의 메일·개인정보 처리방침 링크를 보인다. 로그인 화면과 처리방침에 "지원" 링크',
        refs: ['REQ-F-783'],
      },
    ],
  },
  {
    version: '1.264',
    date: '2026-10-18',
    commit: 'acb916f',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server'],
        text: '세션 즐겨찾기: 세션 ⋯ 메뉴의 "즐겨찾기"로 표시하면 행 제목 앞에 별이 붙고, 최신순 보기에서 맨 위 "즐겨찾기" 절에 모인다. 서버에 저장돼 다른 기기에서도 같다',
        refs: ['REQ-F-782', 'REQ-F-697', 'IF-067'],
      },
    ],
  },
  {
    version: '1.263',
    date: '2026-10-18',
    commit: '8a4ce59',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server', 'agent'],
        text: 'iOS 앱이 TestFlight 에 올린 최신 빌드보다 옛 빌드면, 올린 지 30분 뒤부터 앱을 열 때 "새 버전이 있어요" 창을 띄운다. "TestFlight 열기" 는 TestFlight 앱으로, "나중에" 는 그 빌드를 하루 동안 묻지 않는다. 최신 빌드는 앱을 올리는 운영자 맥의 에이전트가 testflight/result 를 읽어 서버에 알린다(운영자 맥만 받음). 브라우저·데모 계정은 띄우지 않는다',
        refs: ['REQ-F-781'],
      },
    ],
  },
  {
    version: '1.262',
    date: '2026-10-18',
    commit: 'f3f92cb',
    changes: [
      {
        kind: 'fixed',
        scope: ['server'],
        text: '맥 연결이 잠깐 끊겼다 붙으면, 대답을 기다리는 권한 카드가 버튼·명령 없이 "답함" 으로 보여 무엇을 승인한 건지 알 수 없던 것. 이제 맥이 다시 알리는 카드 id 로 열린 카드를 되살린다',
        refs: ['REQ-F-477'],
      },
    ],
  },
  {
    version: '1.261',
    date: '2026-10-18',
    commit: '0ec7288',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: '할 일 패널의 항목을 누르면 "이 일부터 진행"을 보내 하던 일을 두고 넘어가는 말로 읽히던 것을, 지금 하던 일을 마친 뒤 그 일을 이어서 하고 남은 일로 가게 바꾼다. 항목 설명과 대화 카드 머리는 "하던 일 끝나면 이 일 이어서 하기"',
        refs: ['REQ-F-779', 'REQ-F-780'],
      },
    ],
  },
  {
    version: '1.260',
    date: '2026-10-18',
    commit: '87e16a5',
    changes: [
      {
        kind: 'fixed',
        scope: ['server'],
        text: '맥에 시스템 허락 창이 떴다는 알림이, 컴퓨터에 브리지 탭이 열려 있으면 폰으로 가지 않던 것. 이 알림은 맥 앞에서만 처리할 수 있어 페이지가 떠 있어도 푸시한다',
        refs: ['REQ-F-777'],
      },
    ],
  },
  {
    version: '1.259',
    date: '2026-10-18',
    commit: '62cbdaa',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: '도구가 도는 동안 타임라인의 도구 줄과 그 아래 진행 줄이 같은 이름·명령을 두 번 보이던 것. 이제 타임라인에 그 도구 줄이 보이면 진행 줄은 "도구 실행 중 · 경과"만 보인다',
        refs: ['REQ-F-138'],
      },
    ],
  },
  {
    version: '1.258',
    date: '2026-10-18',
    commit: '0e2fab9',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: '할 일이 있을 때 "다시 정리"가 처음 정리와 같은 부탁만 보내, 그사이 다른 세션이 끝낸 일이 남은 일로 남던 것. 이제 남은 일마다 지금 상태(origin/main 커밋, 다른 worktree·PR, 배포 상태 등)를 다시 확인해 완료·빼기·더하기 하고 근거를 끝 괄호에 적어 달라고 부탁한다',
        refs: ['REQ-F-778'],
      },
    ],
  },
  {
    version: '1.257',
    date: '2026-10-18',
    commit: 'e6da7c0',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui', 'server'],
        text: '대화 화면에 같은 줄이 계속 쌓여 위로 올리면 읽던 자리가 밀려 내려가던 것. 배포 중 두 서버가 같은 기록에 번호를 겹쳐 매기지 않고, 화면은 같은 줄을 두 번 그리지 않는다. 열자마자 맨 아래를 따라가지 않던 것도 고쳤다',
        refs: ['REQ-F-468', 'REQ-F-134', 'REQ-F-142'],
      },
    ],
  },
  {
    version: '1.256',
    date: '2026-10-18',
    commit: '87201f5',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: '할 일 패널의 항목을 누르면 그 일 하나만 하고 멈추던 것을, 그 일부터 하고 끝나면 남은 일을 위에서부터 이어서 하게 바꾼다. 항목 설명과 대화 카드 머리는 "이 일부터 하고 이어서 하기"',
        refs: ['REQ-F-779', 'REQ-F-780'],
      },
    ],
  },
  {
    version: '1.255',
    date: '2026-10-18',
    commit: '5a522bb',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server'],
        text: '문제 제보에 동영상을 붙일 수 있다(mp4·mov·webm, 3개, 각 500MB 까지). 올리는 동안 진행률을 보이고, 지난 제보와 운영 화면에서 바로 재생되며, 고치기 세션에는 맥으로 영상 파일이 넘어간다',
        refs: ['REQ-F-735', 'REQ-F-736', 'REQ-F-737', 'REQ-F-739', 'IF-229', 'IF-230', 'IF-231'],
      },
    ],
  },
  {
    version: '1.254',
    date: '2026-10-18',
    commit: '9129a14',
    changes: [
      {
        kind: 'changed',
        scope: ['server'],
        text: '스킬 저장소를 GitHub App 으로 읽을 수 있다(SKILLS_GITHUB_APP_ID·SKILLS_GITHUB_APP_KEY). 1시간짜리 설치 토큰을 저절로 받아 써서, 만료된 토큰을 사람이 바꿔 넣을 일이 없다. App 값이 없으면 SKILLS_GITHUB_TOKEN 을 그대로 쓴다',
        refs: ['REQ-F-290', 'REQ-S-059', 'ERR-036'],
      },
    ],
  },
  {
    version: '1.253',
    date: '2026-10-18',
    commit: '277e9b0',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: '넓은 화면 세션 머리줄의 터미널 화면 버튼을 ⋯ 메뉴로 넣고, 그 자리에 새로고침 버튼을 둔다. 쉬는 세션은 누르면 고르기 시트 없이 바로 새로고침한다',
        refs: ['REQ-F-609', 'REQ-F-718'],
      },
    ],
  },
  {
    version: '1.252',
    date: '2026-10-18',
    commit: '28bfa75',
    changes: [
      {
        kind: 'changed',
        scope: ['server'],
        text: '다른 맥에 맡긴 세션을 그룹 "Bridge 맡긴 세션"에 넣는다(없으면 맨 위에 만든다). 전에는 그룹 밖에 섞였다',
        refs: ['REQ-F-760'],
      },
    ],
  },
  {
    version: '1.251',
    date: '2026-10-18',
    commit: '7258618',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: '할 일 패널이 보낸 부탁(이 일만 하기·남은 일 모두 하기·정리 부탁)을 대화에 지시문 말풍선 대신 할 일 카드(머리 + ▶ 항목)로 그린다',
        refs: ['REQ-F-780'],
      },
    ],
  },
  {
    version: '1.250',
    date: '2026-10-18',
    commit: 'd84b4da',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: '할 일 패널 머리에 ▶("남은 일 {n}개 모두 하기")를 둔다. 누르면 남은 일을 위에서부터 차례로 모두 하라는 부탁을 세션에 보낸다',
        refs: ['REQ-F-779'],
      },
      {
        kind: 'added',
        scope: ['ui'],
        text: '할 일 패널의 남은 항목을 누르면 그 일 하나만 하라는 부탁을 보낸다(마우스를 올리면 ▶ 가 보임). 완료 항목은 누를 수 없다',
        refs: ['REQ-F-779'],
      },
    ],
  },
  {
    version: '1.249',
    date: '2026-10-18',
    commit: '03ceff3',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: '할 일 패널이 왼쪽 목록처럼 화면 바닥까지 세로를 꽉 채운다. 열고 닫을 때 패널 폭과 대화 칸·입력창이 0.26초 동안 미끄러지듯 움직인다(줄인 움직임 설정이면 바로)',
        refs: ['REQ-F-778'],
      },
      {
        kind: 'changed',
        scope: ['ui'],
        text: '넓은 화면의 사용량 게이지는 컨텍스트와 노랑·빨강인 것만 보이고, 나머지는 "+n" 버튼으로 접는다',
        refs: ['REQ-F-149'],
      },
      {
        kind: 'removed',
        scope: ['ui'],
        text: '넓은 화면 입력창의 "AGENTS.md"·"옮기기" 칩을 뺐다. ⋯ 메뉴의 "AGENTS.md"와 "다른 맥으로 옮기기"·"Slack 으로 옮기기"로 한다',
        refs: ['REQ-F-145', 'REQ-F-718'],
      },
    ],
  },
  {
    version: '1.248',
    date: '2026-10-18',
    commit: 'a9dc470',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: '할 일 글의 **굵게**·`코드`를 그린다. 굵은 핵심 낱말은 강조색으로, 글 끝의 괄호 메모 "(…)"는 흐린 색으로 낮춰 무엇을 할지가 먼저 보인다',
        refs: ['REQ-F-778', 'REQ-F-143'],
      },
      {
        kind: 'changed',
        scope: ['ui'],
        text: '할 일 정리 부탁(TODO_ASK)에 항목마다 핵심 낱말 하나를 굵게, 덧붙이는 말은 끝 괄호에 쓰라는 문장을 더한다',
        refs: ['REQ-F-778'],
      },
    ],
  },
  {
    version: '1.247',
    date: '2026-10-18',
    commit: '834a0ad',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: '할 일 표지를 이모지(✅·🔄·⬜)에서 직접 그린 SVG 아이콘으로 바꾼다. 같은 둥근 상자에 할 일은 빈 상자, 하는 중은 강조색 점, 완료는 초록 체크',
        refs: ['REQ-F-778', 'REQ-F-143'],
      },
    ],
  },
  {
    version: '1.246',
    date: '2026-10-18',
    commit: 'dd4b229',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: '할 일 목록(오른쪽 패널·입력창 위 막대)에서 완료 항목을 "완료 N개" 한 줄 아래로 접는다. 누르면 펼치고, 펼침 여부는 이 기기에 기억',
        refs: ['REQ-F-778', 'REQ-F-143'],
      },
    ],
  },
  {
    version: '1.245',
    date: '2026-10-18',
    commit: '91638f6',
    changes: [
      {
        kind: 'changed',
        scope: ['agent', 'server', 'ui'],
        text: '할 일 도구가 생기기 전에 뜬 세션에서 "지금까지 한 일로 정리"를 누르면, 먼저 세션을 다시 열어 도구를 붙인 뒤 정리를 부탁한다. 일하는 중이면 끝난 뒤에 다시 연다',
        refs: ['REQ-F-778'],
      },
    ],
  },
  {
    version: '1.244',
    date: '2026-10-18',
    commit: '118b2fb',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: '할 일 목록(오른쪽 패널·입력창 위 막대)에서 완료한 항목을 맨 아래로 모은다. 남은 일·하는 일은 위에, 각 묶음 안의 순서는 Claude 가 보낸 대로',
        refs: ['REQ-F-778', 'REQ-F-143'],
      },
    ],
  },
  {
    version: '1.243',
    date: '2026-10-18',
    commit: 'c6438a0',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: '위쪽 막대의 "할 일" 버튼으로 패널을 언제든 연다. 할 일이 없으면 "지금까지 한 일로 정리", 있으면 "다시 정리"로 Claude 에게 한 일·하는 일·남은 일 정리를 부탁한다(좁은 화면은 ⋯ 메뉴 "할 일 정리"). 패널 머리의 접기는 닫기로',
        refs: ['REQ-F-778'],
      },
      {
        kind: 'added',
        scope: ['server'],
        text: '답 글 끝의 ```todos 블록([x]·[>]·[ ])을 할 일 목록으로 읽고 글에서 뺀다. todos 도구 없이 뜬 예전 세션도 패널을 채운다',
        refs: ['REQ-F-778'],
      },
    ],
  },
  {
    version: '1.242',
    date: '2026-10-18',
    commit: '7aa8c7b',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: '세션의 할 일을 넓은 화면(1180 px 이상)에서 대화 오른쪽 패널로 보인다: ✅ 완료·🔄 하는 중·⬜ 할 일, 진행 막대, 접기(이 기기에 기억). 좁은 화면의 입력창 위 막대도 같은 이모지',
        refs: ['REQ-F-778', 'REQ-F-143'],
      },
      {
        kind: 'added',
        scope: ['agent', 'server'],
        text: 'bridge MCP 에 todos 도구: Claude 가 할 일 목록을 보내면 대화 기록을 거쳐 패널이 실시간으로 바뀐다. 권한을 묻지 않고, 세 단계 이상인 일에 쓰라고 시스템 프롬프트에 적는다',
        refs: ['REQ-F-778'],
      },
    ],
  },
  {
    version: '1.241',
    date: '2026-10-18',
    commit: '315e369',
    changes: [
      {
        kind: 'fixed',
        scope: ['server'],
        text: '맡긴 세션의 답이 맡긴 쪽 세션에 가지 않던 것. 맥이 턴이 끝났다는 신호를 답보다 먼저 보내는 경우에도 이제 답이 들어오면 전한다',
        refs: ['REQ-F-760'],
      },
    ],
  },
  {
    version: '1.240',
    date: '2026-10-18',
    commit: 'e9446dc',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: '다른 세션의 권한 확인 창에 "Do you want to proceed?" 만 보이고 무엇을 허락하는지 안 보이던 것. 이제 그 창에서도 실행할 명령이나 고칠 파일이 보여요',
        refs: ['REQ-F-080'],
      },
    ],
  },
  {
    version: '1.239',
    date: '2026-10-18',
    commit: '12a0b5c',
    changes: [
      {
        kind: 'fixed',
        scope: ['agent'],
        text: '일하던 세션을 복제하면 복제본이 원본이 하던 일을 이어서 하거나 마저 할지 묻던 것. 이제 그 일은 원본이 계속 맡는다고 복제본에 알려서, 복제본은 새로 받은 요청만 해요',
        refs: ['REQ-F-401'],
      },
    ],
  },
  {
    version: '1.238',
    date: '2026-10-18',
    commit: 'd73f30f',
    changes: [
      {
        kind: 'changed',
        scope: ['ui', 'server', 'agent'],
        text: '화면 문구에서 맥의 폴더 경로 대신 "맥의 에이전트 폴더" 라고 불러요(가이드, 설정 → 음성, 계정 빼기). 데모 대화와 Slack 연결 안내는 앱 이름 Agent Bridge 를 쓰고, 덮개 설정 오류는 맥 화면의 안내에서 명령을 복사하라고 알려요. 붙여 넣는 명령은 그대로예요',
        refs: ['REQ-F-768', 'ERR-115', 'REQ-F-737'],
      },
    ],
  },
  {
    version: '1.237',
    date: '2026-10-18',
    commit: '292ee50',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server'],
        text: '맥에 시스템 허락 창(예: 다운로드 폴더 접근 허락)이 떠서 세션이 멈추면 폰으로 알려 줘요. 맥에서 직접 눌러 주면 알림이 사라져요',
        refs: ['REQ-F-777'],
      },
    ],
  },
  {
    version: '1.236',
    date: '2026-10-18',
    commit: '1f64a6c',
    changes: [
      {
        kind: 'fixed',
        scope: ['server', 'agent', 'ui'],
        text: '다른 맥에 맡긴 세션이 끝나도 맡긴 쪽 세션이 이어받지 않아 "뭐해"라고 물어야 하던 것. 이제 맡긴 세션의 턴이 끝나면 그 답이 맡긴 쪽 대화에 글로 들어가("맡긴 세션의 답") 바로 이어서 일한다',
        refs: ['REQ-F-760'],
      },
    ],
  },
  {
    version: '1.235',
    date: '2026-10-18',
    commit: '3aff6b6',
    changes: [
      {
        kind: 'fixed',
        scope: ['agent'],
        text: '언어 지킴이가 설명 없이 부른 도구에서 그보다 앞의 영어 글이나 안내문을 설명으로 잘못 읽어 한국어 세션의 호출을 돌려보내던 것. 이제 지금 부르는 도구 바로 위에 붙은 글만 본다',
        refs: ['REQ-F-710'],
      },
    ],
  },
  {
    version: '1.234',
    date: '2026-10-18',
    commit: '7685afe',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: 'iOS 앱을 iPhone 전용으로(TARGETED_DEVICE_FAMILY 1, UIDeviceFamily [1]). iPad 에서는 Safari·홈 화면 웹앱으로 계속 쓴다',
        refs: ['REQ-F-756'],
      },
    ],
  },
  {
    version: '1.233',
    date: '2026-10-18',
    commit: 'f3f78ef',
    changes: [
      {
        kind: 'fixed',
        scope: ['agent'],
        text: '압축한 뒤에도 "컨텍스트가 470k 토큰이에요" 압축 권유 띠가 뜨던 것. 압축하면 컨텍스트 크기를 압축 뒤 크기로 바로 바꾼다',
        refs: ['REQ-F-773', 'REQ-F-776'],
      },
    ],
  },
  {
    version: '1.232',
    commit: '4c676b6',
    date: '2026-10-18',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: 'iOS 앱: 키보드 위 ^ v 완료 줄을 비공개 클래스 대신 공개 API(WKWebView 하위 클래스의 inputAccessoryView)로 없앤다. 보이는 것은 그대로',
        refs: ['REQ-F-756'],
      },
      {
        kind: 'security',
        scope: ['ui'],
        text: 'iOS 앱: 웹 검사기(isInspectable)를 디버그 빌드에서만 켠다. TestFlight·App Store 빌드는 열 수 없다',
        refs: ['REQ-F-756'],
      },
    ],
  },
  {
    version: '1.231',
    date: '2026-10-18',
    commit: '944131e',
    changes: [
      {
        kind: 'removed',
        scope: ['ui', 'server', 'agent'],
        text: '음성 받아쓰기의 OpenAI(whisper-1) 방식을 뺐어요. 받아쓰기는 세션이 있는 맥의 whisper.cpp 로만 하고, 녹음은 맥 밖으로 나가지 않아요. 설정 → 음성에서는 모델만 골라요',
        refs: ['REQ-F-754', 'REQ-F-758', 'IF-212', 'IF-213', 'IF-215', 'IF-216', 'IF-214', 'ERR-327'],
      },
      {
        kind: 'changed',
        scope: ['server'],
        text: '예전에 OpenAI 방식으로 저장해 둔 음성 설정은 오류 없이 맥 방식으로 읽어요',
        refs: ['REQ-F-754', 'IF-212'],
      },
      {
        kind: 'security',
        scope: ['server'],
        text: '개인정보 처리방침: 제3자에서 OpenAI 를 빼고 "녹음은 맥 밖으로 나가지 않아요"로 고쳤어요',
        refs: ['REQ-F-767'],
      },
    ],
  },
  {
    version: '1.230',
    date: '2026-10-18',
    commit: '9edb931',
    changes: [
      {
        kind: 'changed',
        scope: ['server', 'ui'],
        text: '"지금 압축" 이 내가 보낸 말풍선으로 남지 않는다. 서버가 /compact 를 넣고 대화에는 "컨텍스트 압축을 요청했어요" 안내만 남긴다(:compact)',
        refs: ['REQ-F-776'],
      },
      {
        kind: 'fixed',
        scope: ['agent'],
        text: '전부 허용에서 권한 창이 먼저 닫힌 뒤 카드 답의 숫자가 입력칸에 남아 다음 메시지 앞에 붙던 것("11/compact …"). 입력칸에 들어간 숫자는 지운다',
        refs: ['REQ-F-437', 'REQ-F-436'],
      },
    ],
  },
  {
    version: '1.229',
    commit: '61c7d58',
    date: '2026-10-18',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: '컨텍스트가 큰 채로 쉬는 세션의 띠가 가벼운 복제 대신 "지금 압축" 을 권한다. 누르면 그 세션에 /compact 를 보내 같은 세션에서 압축하고 그대로 이어간다(요약은 SESSION.md 에도)',
        refs: ['REQ-F-776'],
      },
    ],
  },
  {
    version: '1.228',
    commit: 'd7bb804',
    date: '2026-10-18',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: '컨텍스트가 300k 토큰 이상인 채로 쉬는 세션에 "가벼운 복제" 를 권하는 띠. 닫으면 컨텍스트가 200k 더 커질 때까지 다시 뜨지 않는다',
        refs: ['REQ-F-776', 'REQ-F-402'],
      },
    ],
  },
  {
    version: '1.227',
    commit: 'e32cf41',
    date: '2026-10-18',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server', 'ui'],
        text: '맥 화면에 "자동 압축 시점"(기본·200k·400k·600k). 고르면 그 맥의 bridge 세션이 컨텍스트가 그만큼 차면 압축한다(--settings 의 autoCompactWindow, 내 settings.json 은 그대로). 새로 열거나 다시 여는 세션부터',
        refs: ['REQ-F-775', 'IF-228'],
      },
    ],
  },
  {
    version: '1.226',
    commit: '5b4f250',
    date: '2026-10-18',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server'],
        text: 'iOS 앱 알림: 앱 안에서는 "이 기기로 앱 알림" 스위치로 켜고(그때만 알림 허락을 물음), 결정 대기·작업 끝남 같은 알림이 Apple 푸시(APNs)로 온다. 누르면 그 세션이 열린다. 서버는 node http2 와 ES256 토큰으로 보내고, 쓰이지 않는 토큰(410·BadDeviceToken)은 지운다',
        refs: ['REQ-F-774', 'IF-226', 'IF-227', 'ERR-336'],
      },
      {
        kind: 'changed',
        scope: ['server'],
        text: '같은 iPhone·iPad 에 앱 알림이 있으면 그 기기 종류의 웹 푸시는 보내지 않는다(두 번 오지 않게). 앱에서 로그아웃하거나 계정을 지우면 기기 토큰도 지운다. 서버에 푸시 키가 없으면 등록만 받고 화면에 알린다. 공개 데모는 등록할 수 없다',
        refs: ['REQ-F-517', 'REQ-F-770', 'REQ-F-774'],
      },
    ],
  },
  {
    version: '1.225',
    date: '2026-10-18',
    commit: '63c984e',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server', 'ui'],
        text: '게이지 줄에 "캐시 nn%"(컨텍스트 중 캐시에서 읽은 몫). 누르면 읽음·씀·출력 토큰과 컨텍스트를 다시 쓴 때(세션 시작·1시간 쉼·5분 쉼·모델 변경·압축)를 본다. 에이전트가 대화 기록의 usage 를 세어 status 에 싣는다',
        refs: ['REQ-F-773', 'REQ-F-149'],
      },
    ],
  },
  {
    version: '1.224',
    commit: '4c6826a',
    date: '2026-10-18',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server', 'ui'],
        text: '운영 페이지 "사용자별 기기"에서 맥마다 에이전트 키 상태를 본다: 바꾼 날, 연동 탭이 지금 키로 붙었는지, 예전 키로 온 브라우저와 연동 페이지를 다시 열었는지',
        refs: ['REQ-S-065'],
      },
    ],
  },
  {
    version: '1.223',
    commit: '2976838',
    date: '2026-10-18',
    changes: [
      {
        kind: 'fixed',
        scope: ['agent'],
        text: '에이전트 키를 바꿀 때 꺼져 있던 브라우저가 "연결 안 됨"에 갇히던 것. 그 브라우저가 옛 키로 오면 에이전트가 그 브라우저에 연동 페이지를 새 키로 다시 열어 준다(옛 키에 새 키를 건네지 않음)',
        refs: ['REQ-S-065'],
      },
    ],
  },
  {
    version: '1.222',
    commit: '33571de',
    date: '2026-10-18',
    changes: [
      {
        kind: 'added',
        scope: ['server', 'ui'],
        text: 'iOS 앱 로그인 화면에 "Apple로 로그인"(GitHub 버튼 위, 같은 크기). 서버가 Apple identity token 의 RS256 서명·iss·aud·만료·nonce 를 확인하고, 처음 로그인한 Apple 계정은 운영자 승인을 기다린다',
        refs: ['REQ-F-772', 'IF-224', 'IF-225', 'ERR-335'],
      },
      {
        kind: 'security',
        scope: ['server'],
        text: 'Apple 계정 이름은 apple_… 로 GitHub 이름과 겹치지 않고, 허용 목록(* 포함)·운영자 목록이 적용되지 않아 운영자가 될 수 없다',
        refs: ['REQ-F-772'],
      },
      {
        kind: 'changed',
        scope: ['server', 'ui'],
        text: '계정 삭제: Apple 계정은 "삭제" 를 입력하고, Sign in with Apple 키가 있으면 Apple 토큰도 취소한다. 화면은 Apple 계정을 이름(또는 이메일)으로 부른다',
        refs: ['REQ-F-770', 'REQ-F-772'],
      },
    ],
  },
  {
    version: '1.221',
    date: '2026-10-18',
    commit: 'a2e7d86',
    changes: [
      {
        kind: 'fixed',
        scope: ['agent'],
        text: '새로 만든 에이전트가 첫 연동에서 키를 쓸데없이 바꾸던 것, 3초 안에 탭 두 개가 붙으면 키를 두 번 바꿔 처음 키가 15분 유예 없이 바로 막히던 것(다른 탭·에이전트가 연 연동 링크가 거절됨)을 고쳤다',
        refs: ['REQ-S-065'],
      },
    ],
  },
  {
    version: '1.220',
    date: '2026-10-18',
    commit: '3303329',
    changes: [
      {
        kind: 'removed',
        scope: ['ui', 'server'],
        text: '예전 조작 화면 /cs·/classic 을 없앴다. 두 주소는 / 로 보낸다(302). 그 화면만 쓰던 파일(web/cs, web/app.js, overlay·migrate)과 API(/api/stream, /api/events, /api/state, /api/action, /api/thread/…/send, /api/session/…, /api/pr-view 등)도 함께 없앴다',
        refs: ['REQ-F-235'],
      },
      {
        kind: 'removed',
        scope: ['ui'],
        text: '설정 → 더 보기의 "예전 화면" 줄과, 시작 가이드·첫 화면·로그인 전 가이드의 "예전 Slack 기반 도구에서 옮기기" 길을 없앴다. 예전 /guide/move 주소는 처음 시작 가이드를 연다',
        refs: ['REQ-F-688'],
      },
      {
        kind: 'removed',
        scope: ['agent'],
        text: '예전 화면의 PR 창이 쓰던 prview 명령을 없앴다',
      },
      {
        kind: 'changed',
        scope: ['server'],
        text: '로그인 화면과 승인 대기 안내는 /app.css + /login.css 로 그린다. 연동 탭이 새 배포를 알아보는 지문은 연동 페이지 파일만으로 만든다',
      },
    ],
  },
  {
    version: '1.219',
    date: '2026-10-18',
    commit: '8cd66dc',
    changes: [
      {
        kind: 'changed',
        scope: ['server'],
        text: '공개 데모: 로그인 화면과 승인 대기 안내의 "데모로 둘러보기" 버튼 한 번으로 아이디·비밀번호 없이 들어간다. 누를 때마다 그 사람만의 데모가 생긴다. DEMO_LOGIN·DEMO_PASSWORD 는 없앴고, BRIDGE_DEMO=0 이면 끈다',
        refs: ['REQ-F-766', 'IF-222'],
      },
      {
        kind: 'security',
        scope: ['server'],
        text: '공개 데모 남용 대비: 한 곳에서 1시간에 데모 10개, 동시에 50개(다 차면 15분 안 쓴 것만 비움), 24시간 안 쓴 데모 정리, 글 2,000자, 1분에 보내기 20번, 세션 20개, 본문 64 KB(녹음 1.5 MB). 허용 목록 밖과 남의 맥·세션은 그대로 403',
        refs: ['REQ-S-068', 'REQ-P-170', 'REQ-P-171', 'REQ-P-172', 'REQ-P-173', 'REQ-P-174', 'REQ-P-175', 'ERR-330', 'ERR-332', 'ERR-333', 'ERR-334'],
      },
      {
        kind: 'added',
        scope: ['ui'],
        text: '데모 화면 위쪽 띠에 "내 맥 연결은 GitHub 로그인" 링크',
        refs: ['REQ-F-766'],
      },
    ],
  },
  {
    version: '1.218',
    date: '2026-10-18',
    commit: 'aa01ed8',
    changes: [
      {
        kind: 'changed',
        scope: ['server'],
        text: '로그인 화면에 GitHub 버튼과 같은 모양의 "데모로 둘러보기" 버튼(누르면 아이디·비밀번호 폼). 접힌 작은 링크라 찾기 어려웠다',
        refs: ['REQ-F-766', 'IF-222'],
      },
      {
        kind: 'changed',
        scope: ['server'],
        text: '데모 로그인마다 그 로그인만의 데모 계정과 데모 맥을 새로 만든다. 같은 때 들어온 심사자들이 서로의 화면을 지우지 않는다(계정 삭제도 자기 데모만 되돌림). 서버가 다시 시작했거나 계정이 비워져도 그 로그인으로 오면 처음 상태로 다시 만들어 만료되지 않는다',
        refs: ['REQ-F-766', 'REQ-S-068', 'REQ-F-770'],
      },
      {
        kind: 'added',
        scope: ['server', 'ui'],
        text: '데모에서 설정 저장, 플러그인 목록, 맥 로그·점검, 세션 복제, 음성 입력(데모 맥은 음성 준비됨, 녹음을 보내면 "데모에서는 받아쓰지 않아요" 안내)이 된다',
        refs: ['REQ-F-766', 'REQ-S-068'],
      },
    ],
  },
  {
    version: '1.217',
    date: '2026-10-18',
    commit: '6f8bb8f',
    changes: [
      {
        kind: 'added',
        scope: ['server', 'ui'],
        text: '계정 삭제: 설정 → 더 보기 맨 아래. 확인 창에 지우는 것과 지우지 않는 것(맥의 세션·파일, 이름 고정)을 보이고 로그인 이름을 입력해야 지운다. 서버의 계정·로그인 전부·세션과 대화 사본·그림·설정·알림·푸시 구독·플러그인과 Slack 연결·맥 기록과 연동·접근 요청 기록이 사라지고 맥의 연동은 더 붙지 못한다. 데모 계정은 처음 상태로 되돌린다',
        refs: ['REQ-F-770', 'IF-223', 'ERR-331'],
      },
      {
        kind: 'changed',
        scope: ['server'],
        text: '개인정보 처리방침: 지우는 방법을 "설정 → 계정 삭제, 또는 이메일"로, 저장 항목에 이름 고정을 더함',
        refs: ['REQ-F-767'],
      },
    ],
  },
  {
    version: '1.216',
    date: '2026-10-18',
    commit: 'e1a6232',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: '맡긴 세션 띠: 칩이 제목 · 맥 · 상태 순이고 맥 이름이 두 줄로 깨지지 않는다. 사람을 기다리는 칩(권한 요청·질문)은 주황 테두리로 맨 앞에. 컴퓨터 화면에선 넘치면 다음 줄로 내려간다(전엔 가려졌다)',
        refs: ['REQ-F-760'],
      },
    ],
  },
  {
    version: '1.215',
    date: '2026-10-18',
    commit: 'f1e0000',
    changes: [
      {
        kind: 'fixed',
        scope: ['server'],
        text: 'Claude 가 답 글에 직접 쓴 작업 알림(<task-notification>)이 대화에 XML 로 그대로 보이던 것을 지우고 "실제로 끝난 작업이 아니에요" 안내로 바꾼다. 이 가짜 알림으로 "끝났어요" 알림이 뜨거나 실제 백그라운드 작업이 목록에서 빠지지 않는다.',
        refs: ['REQ-F-057', 'REQ-F-519'],
      },
    ],
  },
  {
    version: '1.214',
    date: '2026-10-18',
    commit: 'a2c9a89',
    changes: [
      {
        kind: 'added',
        scope: ['server', 'ui'],
        text: '개인정보 처리방침: 로그인 없이 /privacy 에서 본다(한국어와 영어 요약). 저장하는 것·보관 기간·지우는 방법·제3자·연락처. 로그인 화면, 승인 대기 안내, 설정 → 더 보기에서 링크',
        refs: ['REQ-F-767', 'REQ-M-018'],
      },
      {
        kind: 'changed',
        scope: ['server', 'ui'],
        text: '사람이 보는 이름을 Agent Bridge 로: 로그인 화면·탭 제목·상단 로고·홈 화면 앱 이름·푸시 기본 제목·가이드 페이지 제목. 로그인 전 화면에 "Anthropic 과 무관한 독립 프로젝트, Claude 는 Anthropic 의 상표" 한 줄',
        refs: ['REQ-F-768'],
      },
      {
        kind: 'changed',
        scope: ['server'],
        text: '승인을 기다리는 계정의 화면: 무엇인지, 필요한 것(맥·에이전트·운영자 승인), 승인되면 어떻게 되는지, 그동안 할 수 있는 것(시작 가이드, 심사용 로그인, 처리방침, 문의처)과 "다시 로그인"',
        refs: ['REQ-F-769', 'ERR-032'],
      },
    ],
  },
  {
    version: '1.213',
    date: '2026-10-18',
    commit: '1b1abda',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: '맡긴 세션 목록: 다른 맥에 일을 맡긴 세션 화면 위쪽에 "맡긴 세션 n" 띠와 이어진 세션마다 칩(상태 점·맥·제목)이 붙고, 누르면 그 세션이 열린다',
        refs: ['REQ-F-760'],
      },
    ],
  },
  {
    version: '1.212',
    date: '2026-10-18',
    commit: 'fee6911',
    changes: [
      {
        kind: 'added',
        scope: ['server', 'ui'],
        text: '데모 모드(앱 심사용): DEMO_LOGIN·DEMO_PASSWORD 가 있으면 로그인 화면에 "심사용 로그인". 로그인하면 서버 안의 가짜 "데모 맥"과 미리 만든 세션 3개(그룹·권한 카드 포함)만 보이고, 보낸 글에 1~2초 뒤 정해진 답이 온다. 로그인할 때마다 처음 상태로 돌아가고, 위쪽에 "데모 모드 · 실제 맥에 연결되지 않아요" 띠',
        refs: ['REQ-F-766', 'IF-222', 'ERR-329', 'ERR-330'],
      },
      {
        kind: 'security',
        scope: ['server'],
        text: '데모 계정(uid demo)은 허용 목록의 API 만 쓰고 그 밖은 403. 다른 사람의 맥·세션 id 를 경로나 본문에 넣어도 403. 운영·연동·QR·푸시·플러그인·제보·sudo·미리보기·업로드·그림은 막힘. 로그인은 상수 시간 비교, 주소당 분당 5번',
        refs: ['REQ-S-068', 'ERR-328'],
      },
    ],
  },
  {
    version: '1.211',
    date: '2026-10-18',
    commit: 'f13a7a2',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: '설정 → 이 기기에 "버전" 카드: 웹 화면 판, iOS 앱 안에서는 앱 버전과 빌드(예: 1.0 (299))도. 앱은 User-Agent 끝에 AgentBridge/<버전> (<빌드>) 를 붙인다(이 판 이후 빌드부터)',
        refs: ['REQ-F-765'],
      },
    ],
  },
  {
    version: '1.210',
    date: '2026-10-18',
    commit: '5b8df0d',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: 'iOS 앱 이름을 Agent Bridge 로 바꿨다. bridge 는 다른 앱이 이미 써서 TestFlight 빌드가 Apple 처리에서 실패했다',
        refs: ['REQ-F-762'],
      },
    ],
  },
  {
    version: '1.209',
    date: '2026-10-18',
    commit: '41709a3',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: '맡긴 세션에서 답하기: 다른 맥에 맡긴 세션이 권한 요청·질문으로 기다리면, 맡긴(부모) 세션 화면 대화 아래에 "<맥> 에 맡긴 세션이 기다려요"와 그 카드가 뜨고 여기서 누른 답이 맡긴 세션에 가서 그대로 이어진다. 그동안 그 카드는 확인 창으로 따로 뜨지 않는다',
        refs: ['REQ-F-760'],
      },
    ],
  },
  {
    version: '1.208',
    date: '2026-10-17',
    commit: '6acd989',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server', 'agent'],
        text: '관리자 권한: 입력창에 `:sudo <명령>`(또는 `:root`)을 쓰면 세션의 맥에서 root 로 바로 실행하고 출력이 대화에 남는다. 비밀번호가 없으면 비밀번호 창이 뜨고, 넣으면 그 맥에서 5분 동안 다시 묻지 않는다(위쪽에 남은 시간과 "닫기")',
        refs: ['REQ-F-764', 'IF-220', 'IF-221'],
      },
      {
        kind: 'added',
        scope: ['agent'],
        text: '세션의 Claude 가 쓰는 sudo(맡긴 세션 포함)도 같은 비밀번호 창으로 묻고, 열린 5분 동안은 그대로 쓴다. 감싸는 `~/.claude-bridge/bin/sudo` 가 askpass 로 에이전트에 묻는다',
        refs: ['REQ-F-764'],
      },
      {
        kind: 'security',
        scope: ['server', 'agent'],
        text: '비밀번호는 맥 에이전트 메모리에만 5분 두고 디스크·로그·인계 파일에 남기지 않는다. 쓸 때마다 서버에 물어 Slack 에서 작업 중인 세션은 거절하고, 비밀번호는 그 맥의 주인만 넣는다(운영자도 안 됨)',
        refs: ['REQ-F-764', 'IF-220'],
      },
    ],
  },
  {
    version: '1.207',
    date: '2026-10-17',
    commit: 'f931293',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server'],
        text: '맡긴 세션 표시: 다른 맥의 세션이 맡긴 세션은 목록에 "맡김" 배지, 화면에 보라색 테두리와 위쪽 띠(어느 맥의 어떤 세션이 맡겼는지, "맡긴 세션 열기")가 붙는다. 그 세션이 보낸 글엔 "맡긴 세션이 보냄"',
        refs: ['REQ-F-760'],
      },
    ],
  },
  {
    version: '1.206',
    date: '2026-10-17',
    commit: '720da0f',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server'],
        text: '새 세션 기본 폴더: 폴더 칸이 <기본 폴더>/<그룹>/<월일>-<id>(예 ~/bridge/works/개발/1017-a3f9c2)로 채워지고 묻지 않고 만들어 시작한다. 기본 폴더·그룹이 없을 때 이름은 설정 → 새 세션에서, 모든 맥에 같이. 최근 폴더는 칩으로',
        refs: ['REQ-F-763', 'IF-191', 'IF-192'],
      },
      {
        kind: 'changed',
        scope: ['server', 'agent'],
        text: '다른 맥에 맡긴 세션: 폴더를 정하지 않으면 홈 대신 같은 규칙의 새 폴더에서 시작',
        refs: ['REQ-F-760'],
      },
    ],
  },
  {
    version: '1.205',
    date: '2026-10-16',
    commit: 'a39c32a',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: 'TestFlight 자동 올리기: 끝난 뒤 lock 이 남아 다음 실행이 모두 멈추던 것, LaunchAgent 에서 Xcode 대신 Command Line Tools 의 xcodebuild 를 쓰던 것',
        refs: ['REQ-F-762'],
      },
    ],
  },
  {
    version: '1.204',
    date: '2026-10-16',
    commit: 'c2be0c5',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: 'iOS 앱 TestFlight 자동 올리기: ios/ 가 바뀐 커밋이 main 에 오르면 Xcode 가 있는 맥이 10분 안에 빌드해 올린다(scripts/testflight.sh)',
        refs: ['REQ-F-762'],
      },
    ],
  },
  {
    version: '1.203',
    date: '2026-10-16',
    commit: 'dfb460f',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: 'iOS 앱: 키보드가 올라올 때 입력창이 잠깐 키보드 뒤로 숨었다 튀어나오던 것. 앱이 키보드 때문에 웹뷰를 줄이지 않는다(앱을 다시 깔아야 적용)',
        refs: ['REQ-F-756'],
      },
    ],
  },
  {
    version: '1.202',
    date: '2026-10-16',
    commit: '2c9efce',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: '입력창: 붙인 영상 칸에 배경을 채웠다. 뒤의 대화 글이 비쳐 보였다',
        refs: ['REQ-F-761'],
      },
    ],
  },
  {
    version: '1.201',
    date: '2026-10-16',
    commit: '9b67f65',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server', 'agent'],
        text: '영상 보내기: 입력창 + 로 영상(mp4·mov·webm, 500MB, 3개까지)을 붙여 보내면 올리는 중 % 를 보이고, 세션의 맥 ~/.claude-bridge/images 에 파일로 놓여 메시지에 경로가 붙는다. 대화에는 🎬 이름',
        refs: ['REQ-F-761', 'IF-218', 'IF-219'],
      },
    ],
  },
  {
    version: '1.200',
    date: '2026-10-16',
    commit: 'a97c6ff',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: '입력창: iOS 앱에서도 키보드에 딱 붙인다. 앱은 키보드가 뜨면 웹뷰 자체가 줄어 키보드를 알아채지 못해 10px 틈이 남았다',
        refs: ['REQ-F-757'],
      },
    ],
  },
  {
    version: '1.199',
    date: '2026-10-16',
    commit: '62db0cf',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: '설정 → 이 기기 "화면 진단 표시": 켜면 세션 화면에 키보드·입력창 위치 숫자를 작게 띄운다(입력창과 키보드 사이 틈의 원인 찾기용)',
        refs: ['REQ-F-757'],
      },
    ],
  },
  {
    version: '1.198',
    date: '2026-10-16',
    commit: '2444597',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: '입력창: 폰 키보드가 떠 있으면 입력창 아래 여백을 없애 키보드에 딱 붙인다. 틈으로 뒤의 대화가 비쳤다',
        refs: ['REQ-F-757'],
      },
      {
        kind: 'fixed',
        scope: ['server'],
        text: '다른 맥에 맡기기: 도구 호출 사이에 잠깐 쉰 것을 끝으로 읽어 중간 말을 답으로 돌려주던 것. 쉬는 상태가 5초 이어질 때만 끝으로 본다',
        refs: ['REQ-F-760'],
      },
    ],
  },
  {
    version: '1.197',
    date: '2026-10-16',
    commit: 'b5519c4',
    changes: [
      {
        kind: 'fixed',
        scope: ['agent'],
        text: '전부 허용이 묻는 비밀 파일을 좁혔다: ~/.claude-bridge 전체가 아니라 agent.json·hook.header·openai.key·browser 와 ~/.claude-bridge-signing 만. 에이전트 코드·로그를 읽어도 물었다',
        refs: ['REQ-F-759'],
      },
    ],
  },
  {
    version: '1.196',
    date: '2026-10-16',
    commit: '2449c0c',
    changes: [
      {
        kind: 'added',
        scope: ['agent', 'server', 'ui'],
        text: '다른 맥에 맡기기: 세션의 Claude 가 bridge MCP 도구(delegate 등)로 서브에이전트처럼 다른 맥에 세션을 열어 일을 맡기고 답을 받는다. 맡긴 세션의 허용 정책을 따라가고, 한 단계만·3개까지, 맡긴 세션이 멈추거나 닫히면 같이. 맥 화면에서 "다른 맥의 일 받기"로 끈다',
        refs: ['REQ-F-760', 'IF-217'],
      },
    ],
  },
  {
    version: '1.195',
    date: '2026-10-16',
    commit: '495630f',
    changes: [
      {
        kind: 'security',
        scope: ['agent'],
        text: '전부 허용이어도 위험한 호출은 카드로 묻는다: 세션 폴더 밖 rm -r, git 강제 push·reset --hard, sudo, 비밀 파일(~/.ssh·.env·~/.claude-bridge·키체인), Claude 설정·LaunchAgents 바꾸기',
        refs: ['REQ-F-759'],
      },
    ],
  },
  {
    version: '1.194',
    date: '2026-10-16',
    commit: '8c5fff5',
    changes: [
      {
        kind: 'added',
        scope: ['agent'],
        text: '음성: 맥이 준비 상태(whisper.cpp·모델·말소리 감지·ffmpeg·OpenAI 키)를 알려 설정 → 음성 "맥마다"에 보인다',
        refs: ['REQ-F-758'],
      },
      {
        kind: 'fixed',
        scope: ['agent'],
        text: '음성: whisper-server 가 말소리 감지(--vad)로 한 번 못 뜨면 에이전트가 도는 내내 감지 없이 돌던 것을, 한 시간 뒤 다시 켜 보게 했다. 음성 모델을 받는 중에 띄워도 그렇게 꺼졌다',
        refs: ['REQ-F-754'],
      },
    ],
  },
  {
    version: '1.193',
    date: '2026-10-16',
    commit: '7a5fa90',
    changes: [
      {
        kind: 'added',
        scope: ['ui', 'server'],
        text: '음성: 설정 → 음성 "맥마다"에서 맥마다 변환 방식·모델을 따로 고르고(비우면 계정 값), 맥마다 준비 상태(whisper.cpp·모델·말소리 감지·ffmpeg·OpenAI 키)를 본다',
        refs: ['REQ-F-758', 'IF-215', 'IF-216'],
      },
    ],
  },
  {
    version: '1.192',
    date: '2026-10-16',
    commit: 'e209d98',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: '입력창: 입력 상자를 아래로 쓸면 폰 키보드가 내려간다',
        refs: ['REQ-F-757'],
      },
    ],
  },
  {
    version: '1.191',
    date: '2026-10-16',
    commit: 'f710f78',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: 'iOS 앱 아이콘을 비율로 다시 그렸다(말풍선 폭 690 가운데, 위 240·아래 176). ios/tools/icon.py 로 위아래를 골라 적용한다',
        refs: ['REQ-F-756'],
      },
    ],
  },
  {
    version: '1.190',
    date: '2026-10-16',
    commit: 'cf8dd94',
    changes: [
      {
        kind: 'changed',
        scope: ['ui'],
        text: 'iOS 앱: 키보드 위 ^ v 완료 줄을 없앴다',
        refs: ['REQ-F-756'],
      },
      {
        kind: 'changed',
        scope: ['ui'],
        text: '입력창: 보내기를 눌러도 폰 키보드가 내려가지 않는다(포커스를 입력창에 둔다)',
        refs: ['REQ-F-757'],
      },
    ],
  },
  {
    version: '1.189',
    date: '2026-10-16',
    commit: 'f6e56af',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: 'iOS 앱(ios/): 웹 화면을 띄우는 얇은 앱. 마이크 허용은 처음 한 번만 묻고 iOS 가 기억한다(홈 화면 웹앱은 켤 때마다 다시 물음)',
        refs: ['REQ-F-756'],
      },
    ],
  },
  {
    version: '1.188',
    date: '2026-10-15',
    commit: '4367c50',
    changes: [
      {
        kind: 'added',
        scope: ['ui'],
        text: 'iPhone 홈 화면 앱: 음성 모드 안내와 설정 → 이 기기에 "Safari로 열기". 홈 화면 앱은 켤 때마다 마이크를 다시 묻지만 Safari 는 허용을 기억한다',
        refs: ['REQ-F-755'],
      },
    ],
  },
  {
    version: '1.187',
    date: '2026-10-15',
    commit: 'aa78862',
    changes: [
      {
        kind: 'fixed',
        scope: ['ui'],
        text: '음성 모드: iPhone 에서 흐린 글이 다시 나온다. 즉시 받아쓰기를 먼저 켜고, 듣기 시작한 뒤에 녹음 마이크를 연다(허용은 그대로 한 번)',
        refs: ['REQ-F-754'],
      },
    ],
  },
  {
    version: '1.186',
    date: '2026-10-15',
    commit: '9e08827',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: '음성 모드: 켤 때 마이크 허용을 두 번 묻던 것. 마이크가 열린 뒤에 즉시 받아쓰기를 켜요', refs: ['REQ-F-754', 'AC-1277'] },
    ],
  },
  {
    version: '1.185',
    date: '2026-10-15',
    commit: '53c3fe1',
    changes: [
      { kind: 'changed', scope: ['ui'], text: '음성 모드: 전송하면 판이 바로 비고, 글이 대화에 바로 흐린 말풍선으로 올라가요. 맥 받아쓰기가 끝나면 그 말풍선이 받아쓴 글로 바뀌며 보내져요', refs: ['REQ-F-754', 'AC-1276'] },
    ],
  },
  {
    version: '1.184',
    date: '2026-10-15',
    commit: '6c2a886',
    changes: [
      { kind: 'changed', scope: ['ui'], text: '음성 모드: 흐린 글만 보여도 전송을 바로 누를 수 있어요. 보낸 글은 판 위에 흐리게 떠 있다가 맥 받아쓰기가 끝나면 흰 글로 바뀌며 보내져요. 판은 바로 비고 계속 들어요', refs: ['REQ-F-754', 'AC-1275'] },
    ],
  },
  {
    version: '1.183',
    date: '2026-10-15',
    commit: 'a0bdd83',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '음성: 말소리 감지(VAD)를 켜서, 주변 소리에 whisper 가 확신 있게 지어낸 "감사합니다." 도 걸러요. 맥이 감지 모델(885 KB)을 한 번 받아 둬요. 짧은 진짜 말("네")은 이제 버리지 않아요', refs: ['REQ-F-754', 'AC-1274'] },
    ],
  },
  {
    version: '1.182',
    date: '2026-10-15',
    commit: 'f10a843',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '음성: 기침·두드림 같은 잡음을 whisper 가 "감사합니다." 같은 말로 지어내던 것을 걸러요. whisper 가 확신하지 못한 짧은 글(20자 이하)은 보내지 않아요', refs: ['REQ-F-754', 'AC-1273'] },
    ],
  },
  {
    version: '1.181',
    date: '2026-10-15',
    commit: '520e654',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '한 번 보낸 메시지가 두 번 가던 문제: 답이 5초 안에 끝나면 에이전트가 전달 안 된 걸로 보고 다시 붙여넣었어요. 다시 넣기 전에 대화 기록에 이미 들어갔는지 확인해요', refs: ['REQ-F-429', 'AC-1272'] },
    ],
  },
  {
    version: '1.180',
    date: '2026-10-15',
    commit: 'c8be9f1',
    changes: [
      { kind: 'changed', scope: ['ui', 'server'], text: '음성 모드: 마이크 버튼(⌥ Space)으로 켜면 입력창 대신 큰 판이 뜨고 계속 들어요. 말하는 동안 글이 바로 보이고(브라우저 받아쓰기), 말을 멈출 때마다 맥의 whisper 가 그 마디를 확정해요. 버튼은 리셋과 전송 둘, Enter 는 전송·Esc 는 리셋', refs: ['REQ-F-754', 'IF-212', 'AC-1270', 'AC-1271'] },
      { kind: 'removed', scope: ['ui', 'server'], text: '누른 채 말하기·버튼 방식·"보내기 전에 보기" 설정: 음성 모드가 대신해요. 설정 → 음성 → 이 기기에 "즉시 받아쓰기" 켜고 끄기가 생겼어요', refs: ['REQ-F-754', 'IF-212'] },
    ],
  },
  {
    version: '1.179',
    date: '2026-10-15',
    commit: '6e632e7',
    changes: [
      { kind: 'added', scope: ['ui', 'server', 'agent'], text: '음성 입력: 입력창의 마이크를 누른 채로 말하면 세션이 있는 맥이 whisper.cpp(또는 OpenAI)로 받아쓰고 군말·용어를 다듬어 입력창에 넣어요. 설정 → 음성에서 켜고, 모델·언어·잡음 줄이기·용어 사전·단축키(⌥ Space)를 골라요', refs: ['REQ-F-754', 'IF-212', 'IF-213', 'IF-214'] },
    ],
  },
  {
    version: '1.178',
    date: '2026-10-15',
    changes: [
      { kind: 'fixed', scope: ['server'], text: 'Slack 에서 굵게가 **…** 그대로 보이던 것: 굵게 안에 코드가 있거나 한글에 바로 붙으면 안 됐어요. 이제 세션의 글을 Slack 이 Markdown 그대로 읽게 보내요', refs: ['REQ-F-541', 'AC-1268'] },
    ],
  },
  {
    version: '1.177',
    date: '2026-10-15',
    commit: '76aa425',
    changes: [
      { kind: 'changed', scope: ['server'], text: 'Slack 자동 허용 묶음에서 같은 도구가 이어서 다룬 파일은 한 줄로(Write a.ts, b.ts), 같은 일을 되풀이하면 ×2. MCP 도구 이름도 짧게', refs: ['REQ-F-753'] },
    ],
  },
  {
    version: '1.176',
    date: '2026-10-15',
    commit: 'c727f20',
    changes: [
      { kind: 'changed', scope: ['server'], text: 'Slack 스레드가 자동 허용 줄로 덮이던 것: 이어지는 자동 허용은 메시지 하나에 한 줄씩(도구와 설명) 모아 고쳐 써요. 명령 원문·바뀐 코드는 Slack 에 올리지 않아요', refs: ['REQ-F-753'] },
      { kind: 'fixed', scope: ['server'], text: '긴 명령·큰 수정의 권한 카드가 Slack 한도(섹션 3,000자)를 넘어 아예 올라가지 않던 것', refs: ['REQ-F-541', 'AC-1267'] },
    ],
  },
  {
    version: '1.175',
    date: '2026-10-14',
    commit: 'da0874e',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '헤드리스 연동 모드를 껐다 켠 뒤 "헤드리스 브라우저가 끝남 (코드 21)" 이 60초마다 되풀이되던 것: 프로필을 쥔 채 살아 있는 Chrome 을 찾아 이어받아요', refs: ['REQ-F-646', 'AC-1265'] },
    ],
  },
  {
    version: '1.174',
    date: '2026-10-13',
    commit: 'acff3c5',
    changes: [
      { kind: 'fixed', scope: ['ui'], text: '폰에서 설정 탭 줄이 좌우로 움직이던 것: 탭이 8개가 되며 폭을 넘었어요. 이제 폰에서는 아이콘 위·이름 아래로 쌓아 한 줄에 다 들어가고, "Claude 계정" 은 "계정" 으로 적어요', refs: ['REQ-F-711'] },
    ],
  },
  {
    version: '1.173',
    commit: '19c24b6',
    date: '2026-10-13',
    changes: [{ kind: 'added', scope: ['ui', 'server'], text: '제보 자동 대응·"이 오류 고치기"에서 세션을 띄울 맥을 고른다(전엔 늘 연결된 첫 맥)', refs: ['REQ-F-737', 'REQ-F-738', 'IF-207'] }],
  },
  {
    version: '1.172',
    date: '2026-10-13',
    commit: '77d20f9',
    changes: [
      { kind: 'added', scope: ['ui', 'server', 'agent'], text: '맥마다 Claude 계정을 여러 개: 설정 → Claude 계정에서 더하고 웹에서 로그인(코드 붙여 넣기)·로그아웃·빼기. 계정마다 로그인·사용량 한도·대화 기록이 따로고, 설정·스킬·플러그인·MCP 는 같이 써요', refs: ['REQ-F-748', 'REQ-F-749', 'IF-211'] },
      { kind: 'added', scope: ['ui', 'server', 'agent'], text: '새 세션을 계정을 골라 시작하고, 세션 메뉴의 "다른 계정으로 옮기기" 로 대화·되감기 사본·폴더 메모리를 그대로 넘김. 다른 맥으로 옮길 때도 받는 계정을 골라요', refs: ['REQ-F-750', 'REQ-F-751', 'IF-066'] },
      { kind: 'added', scope: ['ui'], text: '시작 가이드에 "멀티 계정" 갈래(/guide/accounts)', refs: ['REQ-F-752'] },
    ],
  },
  {
    version: '1.171',
    date: '2026-10-12',
    commit: 'a7061d8',
    changes: [{ kind: 'fixed', scope: ['ui'], text: '헤드리스 브라우저가 대신 연동 중인 맥에서 연동 페이지가 고장처럼(회색 점, "이 탭은 멈춤") 보이던 것', refs: ['REQ-F-693', 'AC-1257'] }],
  },
  {
    version: '1.170',
    date: '2026-10-12',
    commit: '8c27246',
    changes: [
      { kind: 'security', scope: ['server'], text: '운영자에게 남의 맥 기능 줄·백그라운드 오류의 경로가 보이던 것, 두 서버가 함께 돌 때 미리보기 출처가 다시 겹치던 것', refs: ['IF-030', 'REQ-F-727', 'AC-1255'] },
      { kind: 'changed', scope: ['ui', 'server'], text: '서버가 서명 문제로 에이전트 업데이트를 보내지 못하면 기기 화면에 "업데이트 보류"로 표시', refs: ['REQ-S-067'] },
    ],
  },
  {
    version: '1.169',
    date: '2026-10-12',
    commit: '34314c0',
    changes: [
      { kind: 'security', scope: ['server'], text: '미리보기 출처를 넘겨준 세션의 옛 주소가 잠시 뒤 다시 통하던 것', refs: ['REQ-F-727', 'AC-1253'] },
      { kind: 'security', scope: ['server'], text: '운영자에게 남의 맥 점검 목록의 경로가 보이던 것, 서명 순번 기록이 깨지거나 일찍 적히던 것', refs: ['REQ-S-067', 'IF-030', 'AC-1254'] },
    ],
  },
  {
    version: '1.168',
    date: '2026-10-12',
    commit: '2c6f674',
    changes: [
      { kind: 'security', scope: ['server', 'agent'], text: '서명 순번이 뒤로 간 배포가 모든 맥의 업데이트를 막던 것: 서버가 미리 알아채고 보내지 않음', refs: ['REQ-S-067', 'AC-1250'] },
      { kind: 'security', scope: ['server'], text: '운영자에게 남의 맥의 홈 폴더·오류 경로가 보이던 것, 배포 중 미리보기 주소가 만료되던 것, 이름표가 깨지면 모든 이름 보호가 사라지던 것', refs: ['IF-030', 'REQ-F-727', 'AC-1251', 'AC-1252'] },
    ],
  },
  {
    version: '1.167',
    date: '2026-10-12',
    commit: 'd34454f',
    changes: [
      { kind: 'security', scope: ['agent'], text: '서명 순번이 거꾸로 가서 모든 맥이 업데이트를 거절할 수 있던 것, 설치 실패 뒤 이전 판을 다시 받을 수 없던 것', refs: ['REQ-S-067', 'AC-1247'] },
      { kind: 'security', scope: ['server'], text: '배포 뒤 다른 세션끼리 미리보기 출처를 함께 쓰던 것: 배정을 저장하고 지금 가진 세션의 주소만 통함', refs: ['REQ-F-727', 'AC-1248'] },
      { kind: 'security', scope: ['server', 'ui'], text: '운영자가 보는 남의 호스트 로그에서 경로 가림, 이름표 파일이 깨져도 놓아 준 이름이 되살아나지 않음', refs: ['IF-030', 'AC-1249'] },
    ],
  },
  {
    version: '1.166',
    date: '2026-10-12',
    commit: '7c952f8',
    changes: [
      { kind: 'changed', scope: ['agent'], text: '에이전트 업데이트 로그에 서명 순번을 남김', refs: ['REQ-S-067'] },
    ],
  },
  {
    version: '1.165',
    date: '2026-10-12',
    commit: '4fcdc23',
    changes: [
      { kind: 'security', scope: ['agent', 'server'], text: '업데이트 서명이 짧은 지문에 걸려 있어 다른 코드나 바꿔 끼운 파일이 통과할 수 있던 것: 파일 목록 전체와 순번에 서명', refs: ['REQ-S-067', 'AC-1245'] },
      { kind: 'security', scope: ['server'], text: '미리보기 출처 확인값을 흉내 낼 수 있던 것, 최근 세션끼리 미리보기 출처가 겹치던 것', refs: ['REQ-F-727', 'AC-1246'] },
    ],
  },
  {
    version: '1.164',
    date: '2026-10-12',
    commit: '2491520',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '키가 옛 세대인 맥에서 헤드리스 연동 페이지가 옛 버전이면 에이전트가 3초 뒤 꺼지던 것', refs: ['REQ-S-065', 'AC-1242'] },
      { kind: 'security', scope: ['server', 'ui'], text: '놓아 준 이름이 배포 뒤 되살아나던 것, 놓아 줄 때 옛 계정의 로그인을 끝냄, 거절된 시도는 따로 표시', refs: ['REQ-S-025', 'AC-1243'] },
      { kind: 'security', scope: ['server', 'agent'], text: '예전에 만든 대화 파일도 0600 으로, 운영자 로그에 남던 폴더 경로 가림', refs: ['REQ-S-066', 'AC-1244'] },
    ],
  },
  {
    version: '1.162',
    date: '2026-10-12',
    commit: '41c2d23',
    changes: [
      { kind: 'changed', scope: ['agent'], text: '에이전트 업데이트 로그에 관리자 서명을 확인했다고 남김', refs: ['REQ-S-067'] },
    ],
  },
  {
    version: '1.161',
    date: '2026-10-12',
    commit: '7c314c7',
    changes: [
      { kind: 'security', scope: ['agent', 'server'], text: '에이전트 자동 업데이트에 관리자 서명: 서버나 사이트가 뚫려도 맥에 코드를 심지 못함', refs: ['REQ-S-067', 'AC-1240'] },
    ],
  },
  {
    version: '1.160',
    date: '2026-10-12',
    commit: '747ada4',
    changes: [
      { kind: 'security', scope: ['server'], text: '다른 세션의 로컬 미리보기 앱끼리 저장소·쿠키를 나누던 것: 세션마다 다른 미리보기 출처(도메인이 준비되면 자동으로 씀)', refs: ['REQ-F-727', 'AC-1239'] },
    ],
  },
  {
    version: '1.159',
    date: '2026-10-12',
    commit: '0b53551',
    changes: [
      { kind: 'security', scope: ['server', 'ui'], text: '이름을 바꾼 운영자가 다시 로그인하면 옛 이름 고정이 풀리던 것, 운영 화면에서 고정된 이름을 놓아 주기', refs: ['REQ-S-025', 'AC-1237'] },
      { kind: 'security', scope: ['server'], text: '로그아웃된 브라우저가 남의 QR 로그인 주소를 열기만 해도 그 계정으로 로그인되던 것', refs: ['REQ-S-030', 'AC-1236'] },
      { kind: 'security', scope: ['server', 'agent'], text: '대화 파일 0600, 운영자 로그에서 폴더 경로·git 오류 가림, 배포 넘김 비밀값이 미리보기 앱으로 가던 것', refs: ['REQ-R-017', 'AC-1238'] },
    ],
  },
  {
    version: '1.158',
    date: '2026-10-12',
    commit: '033eb59',
    changes: [{ kind: 'fixed', scope: ['ui'], text: '폰에서 세션을 열었다가 목록으로 돌아오면 스크롤이 맨 위로 돌아가던 것(검색어·이어서 하기 펼침도 이어짐)', refs: ['REQ-F-747'] }],
  },
  {
    version: '1.157',
    date: '2026-10-12',
    commit: '8792ddc',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '헤드리스 연동이 예전 페이지를 계속 써서 에이전트 키 교체가 시작되지 않던 것', refs: ['REQ-S-065'] },
    ],
  },
  {
    version: '1.156',
    date: '2026-10-12',
    commit: '6f97ec4',
    changes: [
      { kind: 'security', scope: ['server'], text: '공개 서버는 사이트 주소(BRIDGE_ORIGIN)를 반드시 설정에서 받음: 요청 머리글로 출처를 정하던 것', refs: ['REQ-S-002', 'AC-1234'] },
    ],
  },
  {
    version: '1.155',
    date: '2026-10-12',
    commit: '26cc805',
    changes: [
      { kind: 'security', scope: ['server'], text: '서버가 컨테이너 안에서 root 로 돌던 것: 데이터 폴더를 node 사용자에게 넘기고 그 사용자로 돔', refs: ['REQ-S-066', 'AC-1233'] },
    ],
  },
  {
    version: '1.154',
    date: '2026-10-12',
    commit: '74867f1',
    changes: [
      { kind: 'security', scope: ['agent', 'ui'], text: '예전에 새어 나갔을 수 있는 에이전트 키를 연결을 끊지 않고 한 번 바꿈, 호스트 상태에 "키 바꾸기" 버튼', refs: ['REQ-S-065', 'AC-1232'] },
    ],
  },
  {
    version: '1.153',
    date: '2026-10-11',
    commit: '791c96c',
    changes: [
      { kind: 'security', scope: ['agent'], text: 'Claude 답 속의 확인 창 모양 글이 확인 창으로 읽혀 아래 창이 눌릴 수 있던 것: 아는 창은 세션이 뜰 때와 모델 전환 직후에만 넘김', refs: ['REQ-F-033', 'AC-1231'] },
      { kind: 'security', scope: ['server', 'agent'], text: '다른 운영자의 제보도 전부 허용으로 돌던 것, 운영자에게 남의 git 오류·확인 창 제목이 보이던 것, compact 요약이 링크를 따라 쓰이던 것', refs: ['REQ-F-738', 'IF-030'] },
    ],
  },
  {
    version: '1.152',
    date: '2026-10-11',
    commit: '63de530',
    changes: [
      { kind: 'security', scope: ['server'], text: 'GitHub 이름을 바꾼 계정의 옛 이름을 새로 가진 사람이 그 권한(운영자 포함)으로 로그인하던 것', refs: ['REQ-S-025', 'AC-1229'] },
      { kind: 'security', scope: ['server'], text: 'QR 로그인 주소를 열기만 해도 이미 로그인된 다른 계정이 바뀌던 것: 이제 확인을 받음', refs: ['REQ-S-030', 'AC-1228'] },
      { kind: 'security', scope: ['server'], text: '웹 푸시 구독은 브라우저 푸시 서비스 주소만 받음, 서버 데이터 파일 0600, 배포 넘김 머리글은 공유 비밀값으로만, PR 보기 응답에 보안 머리글, 에이전트 답은 명령 보낸 호스트 것만', refs: ['REQ-S-047', 'REQ-R-017', 'REQ-F-247'] },
    ],
  },
  {
    version: '1.151',
    date: '2026-10-11',
    commit: 'c9bef32',
    changes: [
      { kind: 'security', scope: ['agent'], text: '헤드리스 로그인 주소를 사이트와 비슷한 다른 주소로 바꿔 에이전트 키를 빼 갈 수 있던 것', refs: ['REQ-F-639', 'AC-1226'] },
      { kind: 'security', scope: ['agent'], text: '맥의 아무 그림·폴더 밖 파일이 링크·경로로 서버에 올라가거나 덮어써질 수 있던 것, 받은 폴더의 git 설정이 에이전트 git 에서 프로그램을 돌리던 것', refs: ['REQ-F-722', 'REQ-F-393', 'REQ-F-046'] },
      { kind: 'security', scope: ['agent'], text: '에이전트 폴더(~/.claude-bridge)를 나만 읽게(0700), 로그·백업 0600', refs: ['REQ-F-046'] },
      { kind: 'fixed', scope: ['agent'], text: '두 세션에 같은 순간 보낸 글이 섞일 수 있던 것, 세션과 상관없는 로컬 서버에 1분마다 요청하던 것', refs: ['REQ-F-038'] },
    ],
  },
  {
    version: '1.150',
    date: '2026-10-11',
    commit: '51f5939',
    changes: [
      { kind: 'security', scope: ['server'], text: '로컬 미리보기 주소가 세션이 끝난 뒤에도 24시간 쓰이던 것, 토큰이 든 주소가 다른 사이트로 Referer 로 가던 것, 다른 사이트가 미리보기 웹소켓을 열 수 있던 것', refs: ['REQ-F-727', 'AC-1225'] },
    ],
  },
  {
    version: '1.149',
    date: '2026-10-11',
    commit: '2e5145f',
    changes: [
      { kind: 'security', scope: ['server'], text: '요청 머리글을 바꿔 속도 제한을 피하던 것: 프록시가 쓴 주소로 세고, 잠금 비밀번호 시도는 세션마다도 1분 10번', refs: ['REQ-F-523', 'AC-1224'] },
      { kind: 'fixed', scope: ['server'], text: '잠금 비밀번호 검사가 도는 동안 서버의 다른 요청이 멈추던 것', refs: ['REQ-F-523'] },
    ],
  },
  {
    version: '1.148',
    date: '2026-10-11',
    commit: '5e49ff1',
    changes: [
      { kind: 'security', scope: ['server'], text: 'Slack 연결 링크를 열면 바로 연결되던 것을, 누구를 연결할지 보여 주고 확인을 누를 때만 연결하게', refs: ['REQ-F-540', 'AC-1223'] },
      { kind: 'security', scope: ['server'], text: 'Slack 첨부 그림은 Slack 파일 호스트에서만 봇 토큰으로 받음', refs: ['REQ-F-540'] },
    ],
  },
  {
    version: '1.147',
    date: '2026-10-11',
    commit: 'f15be0e',
    changes: [
      { kind: 'security', scope: ['server'], text: '잠긴 채 끝난 세션의 제목·폴더·첫 메시지가 이어서 하기 목록으로 보이던 것', refs: ['REQ-F-001', 'AC-1221'] },
      { kind: 'security', scope: ['server', 'agent'], text: '운영자가 남의 맥 상태·로그를 볼 때 세션 제목·폴더·대기 글·Claude 설명이 보이던 것', refs: ['REQ-F-223', 'AC-1222'] },
      { kind: 'security', scope: ['server'], text: '대화 사본은 그 호스트의 지금 연동 탭에만 내줌(옛 탭 예외 없앰)', refs: ['REQ-S-016'] },
    ],
  },
  {
    version: '1.146',
    date: '2026-10-11',
    commit: '61e1b16',
    changes: [
      { kind: 'security', scope: ['server'], text: '운영자가 아닌 사람의 제보로 띄우는 고치기 세션은 전부 허용 대신 명령마다 확인받는 모드로, 제보 글은 지시가 아닌 자료로 분리', refs: ['REQ-F-738', 'AC-1219'] },
      { kind: 'fixed', scope: ['server'], text: '화면 정보가 큰 제보가 500 오류로 저장되지 않던 것', refs: ['REQ-F-735', 'AC-1220'] },
    ],
  },
  {
    version: '1.145',
    date: '2026-10-11',
    commit: '772face',
    changes: [
      { kind: 'security', scope: ['agent'], text: '명령 안에 확인 창 문구만 있어도 일반 권한 창이 자동으로 승인되던 것을 막음: 지금 그려진 창의 질문·선택지에서만 판정', refs: ['REQ-F-033', 'AC-1217'] },
      { kind: 'security', scope: ['agent'], text: '프로젝트(.mcp.json)의 MCP 서버 사용 창은 자동으로 넘기지 않고 카드로 물어봄', refs: ['REQ-F-033', 'AC-1218'] },
    ],
  },
  {
    version: '1.144',
    date: '2026-10-11',
    commit: '02664e8',
    changes: [{ kind: 'changed', scope: ['ui'], text: '변경 기록을 changelog 양식으로: 릴리스(SPEC 판)마다 Added·Changed·Fixed·Removed·Security 로 나누고 범위·참조·커밋을 붙인다', refs: ['REQ-F-744'] }],
  },
  {
    version: '1.143',
    date: '2026-10-11',
    commit: '00d54ad',
    changes: [{ kind: 'fixed', scope: ['ui'], text: '폰에서 실시간 상태(작업 중 요약·진행 줄·휴면 버튼·로컬 서버 버튼)가 생기고 사라질 때 목록과 대화가 위아래로 밀리던 레이아웃 이동', refs: ['REQ-F-746'] }],
  },
  {
    version: '1.142',
    date: '2026-10-11',
    commit: 'd358772',
    changes: [{ kind: 'added', scope: ['ui', 'server'], text: '운영 탭과 호스트 상세에 에이전트 build 와 최신 build(AGENT_BUILD)를 함께 보이고 "최신"/"최신 아님" 배지', refs: ['REQ-F-745', 'IF-033'] }],
  },
  {
    version: '1.141',
    date: '2026-10-11',
    commit: '6704cd6',
    changes: [{ kind: 'added', scope: ['ui'], text: '설정에 누구나 보는 "변경 기록" 탭(/settings/changes)', refs: ['REQ-F-744'] }],
  },
  {
    version: '1.140',
    date: '2026-10-11',
    commit: '3cbb98d',
    changes: [{ kind: 'security', scope: ['agent', 'server'], text: '에이전트 키를 tmux 명령줄(ps 에 보임)에서 뺐다. 훅은 /hook·/statusline 에서만 통하는 훅 전용 키를 0600 파일로 읽는다', refs: ['REQ-S-065', 'IF-091'] }],
  },
  {
    version: '1.139',
    date: '2026-10-11',
    commit: '56c0bf6',
    changes: [
      { kind: 'fixed', scope: ['agent'], text: '자동 업데이트가 파일을 바꾸기 전에 새 agent.mjs 와 가져오는 모듈을 link 해 보고, 뜨지 못할 업데이트(ERR_MODULE_NOT_FOUND)는 거절하고 지금 버전으로 계속 돈다', refs: ['REQ-F-369', 'ERR-113'] },
      { kind: 'added', scope: ['agent'], text: '연동 페이지가 30 s 동안 에이전트를 못 찾으면 오류 끝에 그 맥에서 다시 설치하는 명령을 붙인다', refs: ['REQ-F-240'] },
    ],
  },
  {
    version: '1.138',
    date: '2026-10-11',
    commit: 'e09d994',
    changes: [{ kind: 'added', scope: ['ui', 'server'], text: '목록의 "그룹 없음" 절을 그룹처럼 접고 펼친다(서버 collapsed 의 id loose 로 모든 기기 공유)', refs: ['REQ-F-743'] }],
  },
  {
    version: '1.137',
    date: '2026-10-11',
    commit: '90414f5',
    changes: [{ kind: 'added', scope: ['server'], text: '끝난 세션은 closedAt 에서 7일 뒤 "이어서 하기"에서 저절로 지운다(맥의 폴더·대화는 남음)', refs: ['REQ-F-742'] }],
  },
  {
    version: '1.136',
    date: '2026-10-11',
    commit: 'ce4ca9e',
    changes: [{ kind: 'fixed', scope: ['server'], text: '자동 대응 세션 제목을 제보 글로 고정(manualTitle): Claude Code 가 나중에 지은 제목이 덮어쓰던 것', refs: ['REQ-F-738'] }],
  },
  {
    version: '1.135',
    date: '2026-10-11',
    commit: '8610f52',
    changes: [
      { kind: 'changed', scope: ['ui'], text: '운영 화면을 설정의 "운영" 탭으로 옮김(운영자만). /admin 은 그 탭을 연다', refs: ['REQ-F-741'] },
      { kind: 'removed', scope: ['ui'], text: '라우트 admin 과 더 보기의 "운영" 줄', refs: ['REQ-F-741'] },
    ],
  },
  {
    version: '1.134',
    date: '2026-10-11',
    commit: '8efaa13',
    changes: [{ kind: 'changed', scope: ['server'], text: '자동 대응이 켜진 동안엔 고치던 세션이 닫힌 제보를 배포 여부와 상관없이 완료로 지운다', refs: ['REQ-F-740'] }],
  },
  {
    version: '1.133',
    date: '2026-10-11',
    commit: 'dc2e7a4',
    changes: [{ kind: 'added', scope: ['ui'], text: '그룹 메뉴 "휴면 세션 n개"의 세션마다 열기·제거하기 하위 메뉴', refs: ['REQ-F-562'] }],
  },
  {
    version: '1.132',
    date: '2026-10-11',
    commit: 'ad01579',
    changes: [{ kind: 'added', scope: ['server'], text: '자동 대응 세션이 "[제보 대응: 배포 완료]"로 보고를 끝내면 그 턴 뒤 스스로 종료', refs: ['REQ-F-738'] }],
  },
  {
    version: '1.131',
    date: '2026-10-11',
    commit: 'adf0f88',
    changes: [{ kind: 'added', scope: ['server'], text: '배포 뒤 끝난 고치기 세션의 제보를 목록에서 저절로 지운다', refs: ['REQ-F-740'] }],
  },
  {
    version: '1.130',
    date: '2026-10-11',
    commit: '44b000f',
    changes: [{ kind: 'changed', scope: ['server'], text: '자동 대응을 켜면 이미 기다리던 새 제보도 오래된 것부터 바로 시작', refs: ['REQ-F-738'] }],
  },
  {
    version: '1.129',
    date: '2026-10-11',
    commit: '945afa8',
    changes: [{ kind: 'added', scope: ['ui', 'server'], text: '제보 시트는 열 때마다 새 제보로 시작, "지난 제보 보기"로 다시 보기·지우기', refs: ['REQ-F-739', 'IF-208', 'IF-209', 'IF-210'] }],
  },
  {
    version: '1.128',
    date: '2026-10-11',
    commit: 'c526dd4',
    changes: [{ kind: 'added', scope: ['ui', 'server'], text: '제보 자동 대응: 켜 두면 새 제보마다 운영자의 맥에 전부 허용 세션을 띄워 배포까지 고친다(실패하면 60 s 마다 3번까지)', refs: ['REQ-F-738', 'IF-207'] }],
  },
  {
    version: '1.127',
    date: '2026-10-11',
    commit: '6754985',
    changes: [{ kind: 'changed', scope: ['server'], text: '제보 고치기 세션을 그룹 "Bridge 제보 대응"에 넣는다', refs: ['REQ-F-737'] }],
  },
  {
    version: '1.126',
    date: '2026-10-11',
    commit: 'effc850',
    changes: [{ kind: 'fixed', scope: ['ui'], text: '에이전트가 다시 시작하는 동안 입력칸이 막히면 커서가 빠지고 돌아오지 않던 것', refs: ['REQ-F-151'] }],
  },
  {
    version: '1.125',
    date: '2026-10-11',
    commit: 'b1d58fc',
    changes: [{ kind: 'fixed', scope: ['ui'], text: '제보 시트 안내 줄이 글자 사이에서 갈라지던 것(word-break: keep-all)', refs: ['REQ-F-735'] }],
  },
  {
    version: '1.124',
    date: '2026-10-11',
    commit: 'bc5506e',
    changes: [{ kind: 'changed', scope: ['server'], text: '"이 오류 고치기"는 맥에 없는 폴더를 만들어 세션을 띄운다', refs: ['REQ-F-737'] }],
  },
  {
    version: '1.123',
    date: '2026-10-11',
    commit: '6b8be72',
    changes: [{ kind: 'added', scope: ['ui', 'server'], text: '문제 제보: 서비스센터 버튼으로 글·그림과 디버깅 정보를 보내고, 운영 화면에서 보고 "이 오류 고치기"로 세션을 띄운다', refs: ['REQ-F-735', 'REQ-F-736', 'REQ-F-737', 'IF-202'] }],
  },
  {
    version: '1.122',
    date: '2026-10-11',
    commit: 'cab2432',
    changes: [{ kind: 'changed', scope: ['server', 'ui'], text: '운영자도 남의 맥의 에이전트 스위치(지금 복구·헤드리스·잠자기)를 다룬다', refs: ['REQ-F-734'] }],
  },
  {
    version: '1.121',
    date: '2026-10-11',
    commit: 'f0960ef',
    changes: [
      { kind: 'added', scope: ['ui'], text: '단축키 ⌥1~⌥9: n번째 세션 탭으로', refs: ['REQ-F-733'] },
      { kind: 'fixed', scope: ['ui'], text: '⌘Enter 가 한글 조합 중이거나 슬래시 후보가 떠 있으면 보내지지 않던 것', refs: ['REQ-F-075'] },
    ],
  },
  {
    version: '1.120',
    date: '2026-10-11',
    commit: 'fdc14e4',
    changes: [{ kind: 'fixed', scope: ['ui'], text: '펼친 도구 묶음 안의 긴 명령 줄이 화면 밖으로 나가던 것', refs: ['REQ-F-599'] }],
  },
  {
    version: '1.119',
    date: '2026-10-11',
    commit: 'd162210',
    changes: [{ kind: 'added', scope: ['ui', 'server'], text: '새 배포면 열어 둔 화면이 스스로 새로고침(입력 중·시트·메뉴가 열려 있으면 기다림)', refs: ['REQ-F-732', 'IF-193'] }],
  },
  {
    version: '1.118',
    date: '2026-10-11',
    commit: 'a05db02',
    changes: [{ kind: 'added', scope: ['server', 'agent'], text: '로컬 미리보기에 웹소켓이 지나가 다른 기기에서도 HMR 동작', refs: ['REQ-F-727', 'IF-201'] }],
  },
  {
    version: '1.117',
    date: '2026-10-11',
    commit: 'ee839ae',
    changes: [{ kind: 'changed', scope: ['ui'], text: '로컬 서버 메뉴의 "열기"를 "인앱으로 열기"·"새 탭으로 열기" 둘로', refs: ['REQ-F-729'] }],
  },
  {
    version: '1.116',
    date: '2026-10-11',
    commit: 'ee6bd11',
    changes: [{ kind: 'changed', scope: ['ui'], text: '세션 화면에서 휴면을 누르면 세션을 숨기고 목록으로 간다', refs: ['REQ-F-570'] }],
  },
  {
    version: '1.115',
    date: '2026-10-11',
    commit: '888df9c',
    changes: [{ kind: 'changed', scope: ['agent'], text: '전부 허용을 화면 읽기 대신 PermissionRequest 훅에서 답한다(확인 창이 그려지기 전에)', refs: ['REQ-F-731'] }],
  },
  {
    version: '1.114',
    date: '2026-10-11',
    commit: '9008b89',
    changes: [{ kind: 'added', scope: ['ui', 'server'], text: 'Slack 새 세션을 띄울 폴더를 맥마다 버튼으로 정하고, 없는 폴더는 만든다', refs: ['REQ-F-730'] }],
  },
  {
    version: '1.113',
    date: '2026-10-11',
    commit: '3b8c064',
    changes: [{ kind: 'changed', scope: ['ui'], text: '휴면 세션은 어느 길(탭·검색·링크)로 열든 깨운다', refs: ['REQ-F-562'] }],
  },
  {
    version: '1.112',
    date: '2026-10-11',
    commit: '04dd1ed',
    changes: [{ kind: 'added', scope: ['ui', 'agent'], text: '컴퓨터 버튼 우클릭(폰은 길게 누르기)으로 로컬 서버 열기·끄기(SIGTERM, 3 s 뒤 SIGKILL)', refs: ['REQ-F-729', 'IF-200'] }],
  },
  {
    version: '1.111',
    date: '2026-10-11',
    commit: '1f8d255',
    changes: [{ kind: 'added', scope: ['ui', 'server'], text: '아이콘 크기(14~24 px)·채움을 설정에서 고르고 계정에 저장', refs: ['REQ-F-728', 'IF-198', 'IF-199'] }],
  },
  {
    version: '1.110',
    date: '2026-10-11',
    commit: '4188544',
    changes: [{ kind: 'fixed', scope: ['agent'], text: '나뉜 화면(오른쪽 diff 패널)의 글자가 확인 창에 섞여 전부 허용인데도 확인 카드가 뜨던 것: 화면의 왼쪽만 읽는다' }],
  },
]
