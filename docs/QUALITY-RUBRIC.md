# 화면 품질 채점 기준 (성능 · UX)

페이지 하나를 **모바일 / 데스크톱 따로** 재고, 각각 **성능 점수(0–100)** 와 **UX 점수(0–100)** 를 낸다.
현장 데이터(CrUX, 실사용자)는 없으므로 모두 실험실 측정이다. 같은 빌드를 두 평가자가 재면 ±5점 안에 들어와야 한다.

## 0. 측정 환경 (공통)

| 항목 | 모바일 | 데스크톱 |
|---|---|---|
| Lighthouse 12 | 기본값(Moto G Power 에뮬, slow 4G, CPU 4x, 시뮬레이션 쓰로틀) | `--preset=desktop` |
| Playwright 뷰포트 | 390×844, `isMobile: true`, `hasTouch: true`, DPR 3 | 1280×820, DPR 1 |
| 상호작용 측정 CPU | CDP `Emulation.setCPUThrottlingRate {rate: 4}` | 쓰로틀 없음 |
| 추가 폭 점검 | 320px 폭 1회 (가로 스크롤만 확인) | — |

- 빌드는 `vite build` 결과물(프로덕션)만 잰다. dev 서버 금지.
- 로그인이 필요한 페이지는 쿠키를 `--extra-headers`(Lighthouse)·`storageState`(Playwright)로 넣는다.
- 데이터는 고정 시드(세션 20개, 그룹 3단 중첩, 대화 200줄·도구 호출 30개·결정 카드 2개)로 맞춘다. 시드가 다르면 점수 비교 불가.
- Lighthouse는 **3회 실행 후 성능 점수 중앙값인 실행 1개**를 택하고, 그 실행의 지표를 그대로 쓴다.

## 1. 성능 점수 (perfScore)

### 1-1. 기준값: Lighthouse 성능 점수

Lighthouse 10–12의 가중치와 점수 곡선(로그 정규, p10 → 90점, median → 50점):

| 지표 | 가중치 | 모바일 p10 / median | 데스크톱 p10 / median |
|---|---|---|---|
| FCP | 10% | 1.8 s / 3.0 s | 0.93 s / 1.6 s |
| Speed Index | 10% | 3.39 s / 5.8 s | 1.31 s / 2.3 s |
| LCP | 25% | 2.5 s / 4.0 s | 1.2 s / 2.4 s |
| TBT | 30% | 200 ms / 600 ms | 150 ms / 350 ms |
| CLS | 25% | 0.1 / 0.25 | 0.1 / 0.25 |

`base = categories.performance.score × 100` (반올림 정수).

### 1-2. 상호작용 지연 (INP 대용) 측정

INP는 실험실에서 직접 안 나온다. TBT는 이미 LH 점수에 30% 들어가 있으므로, **실제로 그 페이지의 주요 클릭을 Playwright로 눌러서** Event Timing을 잰다.

```js
// 페이지 로드 직후 주입
window.__lat = [];
new PerformanceObserver(l => l.getEntries().forEach(e => {
  if (e.interactionId) window.__lat.push({ name: e.name, dur: e.duration, target: e.target?.tagName });
})).observe({ type: 'event', durationThreshold: 16, buffered: true });
```

- 페이지별 정해진 상호작용 5회(예: 세션 목록 = 그룹 펼치기, 세션 열기, 검색 입력 3글자; 대화 = 도구 행 펼치기, 결정 카드 버튼, 입력창 타이핑) 를 각 3번 반복.
- `interactionId` 별 최대 duration을 모아 **최댓값(worst)** 을 `interactionMs`로 기록 (상호작용이 50개 미만이면 INP 정의상 최댓값 = INP).
- 모바일은 CPU 4x 쓰로틀 상태에서 잰다.

### 1-3. 상한(cap) 규칙 — Core Web Vitals "good" 경계

CWV 경계는 기기와 무관하게 하나다: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 (poor: > 4 s, > 500 ms, > 0.25).

| 조건 (LH 실행값 또는 1-2 측정값) | 상한 |
|---|---|
| LCP > 2.5 s 또는 CLS > 0.1 또는 interactionMs > 200 ms | perfScore ≤ 89 |
| LCP > 4.0 s 또는 CLS > 0.25 또는 interactionMs > 500 ms | perfScore ≤ 49 |
| 페이지 JS 오류로 측정 실패 / 빈 화면 | perfScore = 0 |

`perfScore = min(base, 적용되는 상한 중 가장 낮은 값)`. 감점은 없고 상한만 둔다 → 결정적이고 설명하기 쉽다.

참고 기록용(점수엔 안 씀): TBT, 전송 JS 크기(gzip), 요청 수, 장기 작업 수, 대화 200줄 스크롤 시 프레임 드롭(`requestAnimationFrame` 간격 > 50 ms 횟수).

등급: 90–100 좋음 / 50–89 개선 필요 / 0–49 나쁨 (Lighthouse 색 구간과 같음).

## 1-B. 인터렉티브 성능 점수 (interactiveScore) — 2026-10-10 추가

Lighthouse 성능 점수는 **처음 열 때**만 본다. 열린 뒤 누르고, 끌고, 치고, 굴리고, 열고 닫을 때 버벅이는지는 잡지 못한다
(예: 목록 폭을 끌면 매 움직임마다 페이지 전체를 다시 그려 폭이 커서보다 평균 44px 늦게 따라왔지만 LH 는 98점이었다).
그래서 화면마다 따로 잰다. 근거: INP 경계(좋음 ≤ 200 ms, web.dev/inp), RAIL(입력 응답 ≤ 100 ms, 애니메이션 프레임 ≤ 16.7 ms,
web.dev/rail), Long Animation Frames(> 50 ms, developer.chrome.com/docs/web-platform/long-animation-frames).

### 측정 조건
- 모바일: 390×844, `hasTouch`, CDP `Emulation.setCPUThrottlingRate {rate: 4}`. 데스크톱: 1280×820, 감속 없음.
- 화면이 다 그려지고(네트워크 조용) 1 s 뒤부터 잰다. 시나리오마다 3번, 가장 나쁜 값.
- 시나리오: 그 화면의 **모든 상호작용 종류**를 하나 이상 — 누르기(버튼·행·메뉴 항목), 열고 닫기(접기, 시트, 메뉴, 도구 줄), 끌기(폭 조절, 순서 바꾸기, 밀기), 치기(입력칸·검색), 굴리기(긴 목록·대화), 화면 이동(목록 ↔ 대화). 화면별 목록은 평가자가 정하고 결과에 적는다.

### 지표
| 지표 | 재는 법 | 점수 곡선 (100 → 90 → 50 → 0) |
|---|---|---|
| I1 상호작용 지연 (50%) | 각 이산 상호작용의 Event Timing `duration`(PerformanceObserver `event`, `durationThreshold: 16`)의 최댓값 | ≤ 100 ms → 100, 200 → 90, 500 → 50, ≥ 1000 → 0 (구간 사이 직선) |
| I2 매끄러움 (35%) | 연속 상호작용(끌기·굴리기·애니메이션 재생) 동안 rAF 간격이 33.4 ms 를 넘는 프레임 비율, 그리고 LoAF(> 50 ms) 개수 | 비율 0 % → 100, 5 % → 90, 20 % → 50, ≥ 40 % → 0. LoAF 1개당 −5 |
| I3 따라옴·되울림 (15%) | 끌기: 포인터와 따라 움직이는 가장자리의 평균 거리(px). 치기: 키 입력 → 그 글자가 화면에 그려질 때까지(p95, ms) | 끌기 ≤ 8 px → 100, 16 → 90, 48 → 50, ≥ 96 → 0 / 치기 ≤ 50 ms → 100, 100 → 90, 300 → 50, ≥ 600 → 0 (둘 다 있으면 낮은 쪽) |

`interactiveScore = round(0.5·I1 + 0.35·I2 + 0.15·I3)`. 끌기·치기가 없는 화면은 I3 를 빼고 I1·I2 를 0.59·0.41 로 나눈다.
상한: 어떤 상호작용이든 500 ms 넘게 무반응이거나, 끌기·굴리기 중 200 ms 넘는 멈춤이 있으면 ≤ 59.
결과 JSON 에 `interactiveScore`, `interactive: {I1, I2, I3, scenarios:[{name, kind, maxEventMs, droppedPct, loaf, lagPx|echoMs}]}` 를 더한다.

## 2. UX 점수 (uxScore) — 합계 100

| 묶음 | 배점 | 성격 |
|---|---|---|
| A. 자동 검사 | 40 | 기계적, 평가자 판단 없음 |
| B. 키보드·포커스 | 10 | 절차 고정, 판정 거의 기계적 |
| C. 반응·모션 | 10 | 측정 + 코드/CSS 확인 |
| D. 상태 화면 | 10 | 네트워크 조작 후 스크린샷 판정 |
| E. 휴리스틱 평가 | 30 | 평가자 판정 (심각도 앵커로 고정) |

### A. 자동 검사 (40)

| ID | 항목 (배점) | 방법 | 점수 |
|---|---|---|---|
| A1 | 접근성 (20) | Lighthouse accessibility 점수 (axe-core 기반: 대비 4.5:1, 레이블, 이름, ARIA, 언어 등) | `LH_a11y × 20` (소수 1자리) |
| A2 | 모범 사례 (5) | Lighthouse best-practices 점수 (콘솔 오류, HTTPS, 이미지 비율 등) | `LH_bp × 5` |
| A3 | 터치/클릭 타깃 (10) | DOM: `a, button, input, select, textarea, summary, [role=button], [role=tab], [role=menuitem], [onclick], [tabindex]:not([tabindex="-1"])` 중 보이는 요소의 `getBoundingClientRect()`. 본문 문장 안 링크(inline)는 제외 | 아래 |
| A4 | 반응형·가독성 (5) | DOM/CSS 계산값 | 아래 |

**A3 세부** (WCAG 2.5.8 AA = 24×24 CSS px, 단 24px 원 간격 예외 인정 / Apple HIG 44pt, Material 48dp):
- `v24` = 24×24 미만이면서 간격 예외도 안 되는 요소 수 (WCAG 위반).
- `v44` = (모바일만) 24 이상이지만 짧은 변 < 44 px인 주요 조작 요소 수 (전송, 세션 열기, 결정 카드 버튼, 탭바, 닫기/뒤로).
- 점수 = `max(0, 10 − 2×v24 − 0.5×v44)`. 데스크톱은 `v44` 안 셈.

**A4 세부** (각 1점, 모바일 기준. 데스크톱은 a·c·e만 보고 b·d는 자동 만점):
- a. 390px·320px 모두 `document.documentElement.scrollWidth <= innerWidth` (가로 스크롤 없음, WCAG 1.4.10 Reflow).
- b. 본문 텍스트(`p, li, 메시지 본문`) 계산 `font-size ≥ 16px` (보조 텍스트 12px 이상 허용).
- c. `<meta name="viewport">` 에 `user-scalable=no`/`maximum-scale=1` 없음 (확대 허용, WCAG 1.4.4).
- d. 모든 `input, textarea, select` 의 `font-size ≥ 16px` (iOS 사파리 포커스 확대 방지).
- e. safe-area: 하단 고정 입력창·탭바가 `env(safe-area-inset-bottom)` 을 반영하거나 하단 34px 안에 조작 요소가 없음 (데스크톱은 200% 확대 시 내용 잘림 없음으로 대체).

### B. 키보드·포커스 (10)

절차: 주소창 다음부터 `Tab` 을 끝까지(최대 80회) 누르며 매 단계 스크린샷 + `document.activeElement` 기록. 모바일 폼은 하드웨어 키보드 연결 상황으로 같은 절차를 한 번만 본다.

| ID | 항목 (배점) | 만점 | 절반 | 0 |
|---|---|---|---|---|
| B1 | 포커스 표시 (5) — WCAG 2.4.7, 2.4.11 | 모든 포커스 대상에 눈에 보이는 링/윤곽(배경 대비 3:1, 두께 ≥ 2px 상당) | 1–2개 요소에서 안 보임 | 3개 이상 안 보이거나 전역 `outline: none` |
| B2 | 조작·순서 (5) — WCAG 2.1.1, 2.4.3, 2.1.2 | 모든 기능이 키보드로 됨, 순서가 시각 순서와 일치, 모달/시트는 포커스 가둠 + `Esc` 닫힘 + 닫으면 원래 버튼으로 복귀 | 위 중 1개 실패 | 2개 이상 실패 또는 키보드 함정 |

### C. 반응·모션 (10)

| ID | 항목 (배점) | 방법 | 점수 |
|---|---|---|---|
| C1 | 즉시 반응 (5) | 1-2의 상호작용 각각에 대해 클릭 → 첫 시각 변화(눌림 상태, 스피너, 낙관적 반영)까지 시간. `MutationObserver` + 다음 `requestAnimationFrame` 시각으로 계산. 기준 100 ms (Nielsen 응답 한계) | 전부 ≤ 100 ms: 5 / 1–2개 초과: 2.5 / 3개 이상 초과 또는 1 s 넘게 무반응: 0 |
| C2 | 모션 (5) | (a) `page.emulateMedia({reducedMotion:'reduce'})` 후 같은 조작 → 이동·확대 애니메이션 꺼짐 또는 페이드로 대체 (WCAG 2.3.3) (b) 계산된 `transition-duration`/`animation-duration` 이 UI 전환에서 100–500 ms (Material: 작은 요소 100–200, 화면 전환 300–500) (c) 무한 반복 애니메이션은 진행 표시뿐 | 3개 다 충족: 5 / 1개 실패: 2.5 / 2개 이상: 0 |

### D. 상태 화면 (10)

Playwright `page.route` 로 API 응답을 조작하고 스크린샷 판정.

| ID | 상태 (배점) | 만드는 법 | 만점 조건 |
|---|---|---|---|
| D1 | 로딩 (4) | API 응답 2 s 지연, 300 ms·1 s 시점 캡처 | 스켈레톤/스피너 등 진행 표시가 있고, 데이터 도착 후 CLS ≤ 0.1 (레이아웃 점프 없음). 빈 흰 화면이면 0 |
| D2 | 빈 상태 (3) | 목록 API를 `[]` 로 | 무엇이 비었는지 + 다음 행동(예: "새 세션 시작") 이 한국어로 보임. 문구만 있으면 1.5, 아무것도 없으면 0 |
| D3 | 오류 (3) | API 500 / `route.abort()` / 오프라인 | 원인 설명 + 다시 시도 수단, 기존 화면 유지(통째로 사라지지 않음). 영어 원문 스택·`undefined` 노출은 0, 문구만 있고 재시도 없음 1.5 |

해당 상태가 원래 없는 페이지(정적 SSR 안내 페이지 등)는 그 항목 만점 처리하고 `notApplicable` 에 적는다.

### E. 휴리스틱 평가 (30) — Nielsen 10 원칙 × 3점

평가자는 스크린샷과 직접 조작(1-2 시나리오 + 자유 탐색 5분)으로 원칙마다 문제를 찾고, Nielsen **심각도 0–4** 를 매긴다. 원칙 점수는 그 원칙에서 나온 **가장 심각한 문제**로만 정한다:

| 최악 심각도 | 0–1 (없음/외관) | 2 (경미) | 3 (주요) | 4 (치명) |
|---|---|---|---|---|
| 원칙 점수 | 3 | 2 | 1 | 0 |

심각도 앵커 (두 평가자 일치용):
- **4 치명**: 과업을 끝낼 수 없음, 데이터 손실, 되돌릴 수 없는 동작이 확인 없이 실행.
- **3 주요**: 끝낼 수는 있지만 대부분 사용자가 막히거나 오조작함, 또는 매번 반복되는 큰 지연·혼란.
- **2 경미**: 잠깐 머뭇거리게 함, 우회 쉬움.
- **1 외관**: 정렬·여백·문구 다듬기 수준.

이 앱 기준 원칙별 점검 포인트:

| # | 원칙 | 이 앱에서 볼 것 |
|---|---|---|
| E1 | 시스템 상태 표시 | 세션 실행/대기/권한요청 상태가 목록·대화에서 구분되는가, 연결 끊김 표시, 전송 중 표시 |
| E2 | 현실 세계와 일치 | 한국어 용어 일관·자연스러움, 개발자 내부 용어(raw tool 이름, id) 노출 정도 |
| E3 | 사용자 통제·자유 | 뒤로가기/스와이프로 목록 복귀, 실수한 입력 취소, 실행 중지 수단 |
| E4 | 일관성·표준 | 같은 동작 같은 모양(버튼 위계, 아이콘), 플랫폼 관례(모바일 하단 입력, 데스크톱 Enter 전송) |
| E5 | 오류 예방 | 결정 카드 거절/허용 오조작 방지, 세션 삭제·종료 확인, 긴 입력 유실 방지 |
| E6 | 기억보다 인식 | 현재 어느 그룹·세션인지 항상 보임, 최근 세션 접근, 도구 행 요약이 펼치지 않아도 이해됨 |
| E7 | 유연성·효율 | 단축키(데스크톱), 검색/필터, 중첩 그룹 빠른 이동, 반복 작업 단축 |
| E8 | 미니멀 디자인 | 대화 화면의 정보 밀도, 도구 호출이 본문을 묻지 않는가, 불필요한 장식 |
| E9 | 오류 인식·복구 | 오류 문구가 원인·해결책을 말하는가 (D3보다 넓게: 권한 실패, 세션 죽음 등) |
| E10 | 도움말·문서 | 첫 사용 안내, 빈 상태 안내, 설정 항목 설명 |

규칙: 같은 문제는 가장 관련 큰 원칙 **하나에만** 매긴다 (중복 감점 금지). A–D에서 이미 감점된 것(대비, 타깃 크기, 빈/오류 화면 유무)은 E에서 다시 매기지 않는다. 두 평가자가 있으면 원칙별 점수 평균, 차이가 2점이면 합의 후 재판정.

### 합산

`uxScore = A1 + A2 + A3 + A4 + B1 + B2 + C1 + C2 + D1 + D2 + D3 + E1…E10` (소수 1자리 → 최종 반올림 정수).
추가 상한: Lighthouse 접근성 < 0.7 이거나 심각도 4 문제가 하나라도 있으면 `uxScore ≤ 59`.

## 3. 페이지별 출력 형식 (JSON)

평가자는 페이지×폼마다 아래 객체 하나를 낸다. 여러 개면 배열.

```json
{
  "page": "/s/:id (대화)",
  "url": "https://bridge.creco.dev/s/abc",
  "form": "mobile",
  "build": "git sha 7자리",
  "measuredAt": "2026-10-10T12:00:00+09:00",
  "perfScore": 72,
  "perf": {
    "lighthouse": 81,
    "capsApplied": ["LCP>2.5s → ≤89", "interactionMs>200 → ≤89"],
    "metrics": { "fcpMs": 1900, "siMs": 3100, "lcpMs": 2900, "tbtMs": 240, "cls": 0.03,
                 "interactionMs": 230, "interactions": [{ "name": "도구 행 펼치기", "ms": 230 }],
                 "jsKbGzip": 182, "requests": 14 }
  },
  "uxScore": 78,
  "ux": {
    "A1": 18.4, "A2": 5, "A3": 7, "A4": 4,
    "B1": 2.5, "B2": 5,
    "C1": 5, "C2": 2.5,
    "D1": 4, "D2": 1.5, "D3": 3,
    "E": { "E1": 3, "E2": 2, "E3": 3, "E4": 2, "E5": 1, "E6": 3, "E7": 3, "E8": 2, "E9": 3, "E10": 3 },
    "capsApplied": [],
    "notApplicable": []
  },
  "raw": {
    "lhA11y": 0.92, "lhBestPractices": 1.0,
    "targetsUnder24": 1, "targetsUnder44": 2,
    "horizontalScroll320": false, "minInputFontPx": 16, "minBodyFontPx": 15,
    "focusInvisible": ["button.icon-copy"]
  },
  "issues": [
    {
      "id": "conv-m-01",
      "rubric": "A3",
      "severity": 2,
      "where": "button[aria-label='복사'] (대화 도구 행 오른쪽 위)",
      "evidence": "20×20px, 이웃 버튼과 4px 간격 / screenshots/conv-m-03.png",
      "fix": "hit area를 padding 으로 44×44까지 키우고 아이콘은 20px 유지"
    }
  ]
}
```

필드 규칙:
- `severity` 는 E 항목은 Nielsen 0–4, A–D 항목은 영향도로 같은 척도를 쓴다 (WCAG A/AA 위반 = 최소 2).
- `where` 는 CSS 선택자 우선, 선택자가 불안정하면 "화면 영역 + 보이는 문구".
- 모든 감점 항목에는 `issues` 가 최소 1개 있어야 한다 (근거 없는 감점 금지).
- 스크린샷은 `screenshots/<page>-<m|d>-<번호>.png` 로 저장하고 `evidence` 에 경로를 쓴다.

전체 요약은 페이지별 점수의 단순 평균과 최저 페이지를 함께 보고한다 (평균만 보면 나쁜 페이지가 묻힌다).

## 4. 출처

- Lighthouse 성능 점수 가중치·색 구간: https://developer.chrome.com/docs/lighthouse/performance/performance-scoring
- 지표별 점수 곡선(p10/median): https://github.com/GoogleChrome/lighthouse/tree/main/core/audits/metrics (largest-contentful-paint.js, total-blocking-time.js, first-contentful-paint.js, speed-index.js, cumulative-layout-shift.js)
- Core Web Vitals 경계: https://web.dev/articles/vitals , https://web.dev/articles/inp , https://web.dev/articles/lcp , https://web.dev/articles/cls
- Event Timing / INP 측정: https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEventTiming , https://web.dev/articles/manually-diagnose-slow-interactions-in-the-lab
- Lighthouse 접근성 점수(axe 가중): https://developer.chrome.com/docs/lighthouse/accessibility/scoring
- WCAG 2.2 (1.4.3 대비, 1.4.4, 1.4.10, 2.1.1, 2.4.7, 2.4.11, 2.5.8): https://www.w3.org/TR/WCAG22/ , https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- Apple HIG 44pt: https://developer.apple.com/design/human-interface-guidelines/accessibility
- Material 48dp 타깃, 모션 시간: https://m3.material.io/foundations/designing/structure , https://m3.material.io/styles/motion/easing-and-duration
- prefers-reduced-motion: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- iOS 입력 16px 미만 자동 확대: https://css-tricks.com/16px-or-larger-text-prevents-ios-form-zoom/
- Nielsen 10 휴리스틱 / 심각도 0–4 / 응답 시간 한계: https://www.nngroup.com/articles/ten-usability-heuristics/ , https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/ , https://www.nngroup.com/articles/response-times-3-important-limits/
