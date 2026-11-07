// Claude 로 정리 후보 찾기 (REQ-F-882): the first message of a session started in the host's home folder from the
// 디스크 관리 칸. It asks for candidates first and deletes only what the person then approves, so starting it
// changes nothing on the disk. The buttons of the same box (캐시·머지된 worktree·큰 폴더) stay the quick path; this
// one looks where they do not: what the visible sizes do not add up to, test output, VM disks, app clones.

export const DISK_PROMPT_TITLE = '디스크 정리'

/**
 * What session.create gets: the home folder (never made), and 'default' so every permission is asked whatever the
 * person's 전부 허용 default is — this session deletes things.
 */
export const diskSession = (hostId: string, startKey: string) => ({ hostId, cwd: '~', prompt: DISK_PROMPT, title: DISK_PROMPT_TITLE, startKey, mode: 'default', create: false })

export const DISK_PROMPT = `이 기기의 디스크를 정리해줘. 아래 순서와 원칙을 지켜.

## 원칙
- 아무것도 지우기 전에 후보부터 보고하고, 내가 승인한 범위만 지운다.
- 단계마다 지운 뒤 df 로 실제 여유 공간을 다시 재서 보여준다. du 추정치로 "얼마 확보"라고 말하지 않는다.
- 캐시(npm, go, uv, yarn, Homebrew, 브라우저 캐시)는 비워도 다시 차니까 우선순위를 가장 낮게 둔다. 다시 생기지 않는 찌꺼기를 먼저 찾는다.
- 지우기 직전에 lsof 로 쓰는 프로세스가 없는지 확인한다.
- 건드리지 않는다: ~/.claude, ~/.claude-bridge 같은 Claude·에이전트 폴더, 열린 세션의 작업 폴더, ~/.ssh·키·설정 폴더.
- macOS 전용 항목은 macOS 일 때만, Linux 전용 항목은 Linux 일 때만 본다(uname 으로 먼저 확인).

## 1. 측정: 보이는 크기와 실제 사용량의 차이부터
- df 사용량과 홈·앱·패키지 관리자 폴더의 du 합계를 비교한다(macOS: ~ /Applications /opt/homebrew /Library /private/var/folders).
- 차이가 크면 숨은 곳을 의심한다. macOS 는 /private/var/folders/*/*/X(앱 임시 복제본)와 VM 디스크 이미지를 본다.
- du 가 디스크보다 크게 나오면 APFS 복제(clone)나 sparse 파일이다. 겉보기 크기와 실제 차지하는 크기를 나눠 보고한다.

## 2. 다시 생기지 않는 찌꺼기 찾기
- Downloads: 이미 설치한 앱의 설치 파일(.dmg/.pkg), 받다 끊긴 파일(.crdownload, .download).
- git worktree: 저장소마다 git worktree list 를 보고, git fetch 한 뒤 고친 것 없음(status --porcelain 0줄)·머지됨(rev-list origin/<기본 브랜치>..브랜치 0개)·쓰는 프로세스 없음 세 가지가 다 맞는 것만 git worktree remove 한다(locked 면 unlock). 브랜치는 남긴다.
- 프로젝트 안 테스트·빌드 산출물: 큰 숨김 폴더(.artifacts, .next, dist, coverage 등) 중 git check-ignore 로 무시되고 git 이 추적하는 파일이 0개인 것.
- Docker·VM:
  - 멈춘 컨테이너 중 빌드 실패 찌꺼기(Exited 1/137)와 쓰지 않는 이미지.
  - 볼륨은 안을 열어 보고, DB 데이터(PG_VERSION 등)면 남긴다. DB 를 건드려야 하면 먼저 백업하고 백업이 됐는지 확인한다.
  - prune 만으로는 VM 디스크 파일이 줄지 않으니 VM 안에서 fstrim -av 를 한다(colima: colima ssh -- sudo fstrim -av). 그 뒤 호스트에서 디스크 파일 크기를 다시 잰다.
- 앱이 강제 종료될 때 남기는 임시 복제본(예: com.google.Chrome.code_sign_clone): 개수, 날짜 분포, 버전 분포를 보고하고 지금 쓰는 것(lsof)은 뺀다. 왜 생기는지는 추측하지 말고 소스나 문서로 확인한다.

## 3. 재부팅으로 정리되는 것은 재부팅으로
- OS 가 부팅 때 지우는 곳(/private/var/folders 의 X·T, /private/tmp)은 직접 지우기보다 재부팅이 안전하다.
- 재부팅은 제안만 한다. 하기 전에 아래를 보고하고 내 승인을 받는다:
  - 자동 로그인과 FileVault 상태(원격으로 쓰는 기기면 로그인 화면에서 멈추지 않는지)
  - LaunchAgent·LaunchDaemon 의 RunAtLoad·KeepAlive, brew services, 로그인 항목, 컨테이너 재시작 정책으로 본, 다시 뜨는 것과 안 뜨는 것
  - 재부팅하면 끊기는 것(이 세션을 포함한 열린 세션, 돌던 작업, /tmp 의 작업물)
- 승인하면 재부팅 전 상태를 ~/disk-check-before.txt 에 남기고, 이 답장이 전해지도록 수십 초 늦춰 재부팅한다. 다시 연결되면 같은 항목을 다시 재서 비교한다.

## 4. 보고 형식
- 후보는 🟢 바로 지워도 됨 / 🟡 확인 필요로 나누고, 항목마다 크기·지웠을 때 영향·근거를 적는다.
- 끝나면 단계별 df 변화, 지운 것, 일부러 남긴 것과 이유, 다시 쌓이는 원인과 막는 방법을 정리한다. 막는 방법은 제안하기 전에 실제로 시험해서 부작용(설정 플래그끼리 덮어쓰기 등)이 없는지 확인한다.`
