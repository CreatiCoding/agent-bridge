// Codex 로 이어서 작업 (REQ-F-857): what the Claude Code session is asked for, what the Codex session is told, and how
// the summary is read back out of the conversation. No React here: the unit tests import it.
import type { Ev } from './types'

/** What the Claude session is asked for. Its head finds the request again in the conversation. */
export const HANDOFF_ASK_HEAD = '이 작업을 같은 폴더의 Codex 세션이 이어서 하도록 인계 요약을 써 주세요.'
export const HANDOFF_ASK = `${HANDOFF_ASK_HEAD} 받는 쪽은 이 대화를 볼 수 없어요. 파일은 고치지 말고, 커밋·stash·되돌리기도 하지 마세요. 먼저 git 저장소라면 \`git status --short\` 와 \`git diff --stat\` 으로 지금 변경을 확인하세요. 그다음 답 맨 끝에 \`\`\`handoff 블록 하나로 아래 제목을 순서대로 채워 주세요. 블록 안에는 \`\`\` 를 쓰지 마세요.

## 목표
## 요구사항 — 사용자가 말한 조건·금지 사항을 빠짐없이 (대화 초반과 압축 전에 말한 것도)
## 결정 사항 — 무엇을 왜 그렇게 정했는지
## 변경 파일 — 경로, 무엇을 바꿨는지, 커밋했는지
## 검증 결과 — 돌린 명령과 결과, 아직 안 한 검증
## 남은 작업 — 다음에 할 첫 단계부터 순서대로
## 주의 — 작업 폴더·worktree·브랜치, 지켜야 할 저장소 규칙

경로·명령·숫자는 그대로 적어 주세요.`

/** What the Codex session is told before the summary. */
export const HANDOFF_HEAD =
  '같은 폴더의 Claude Code 세션에서 하던 작업을 이어받아 주세요. 아래는 그 세션이 쓴 인계 요약이에요. 시작하기 전에 `git status` 와 변경 파일을 직접 읽어 요약과 지금 상태가 맞는지 확인하고, 다르면 지금 상태를 믿어 주세요. 미커밋 변경은 이어받은 작업의 일부라 되돌리거나 지우지 말고, 작업 폴더·worktree·브랜치도 바꾸지 마세요. 확인이 끝나면 "남은 작업"의 첫 단계부터 이어서 진행해 주세요.'

/** The summary in an answer: the last ```handoff block, or null when the answer has none. */
export function handoffOf(text: string): string | null {
  const all = [...text.matchAll(/```handoff[^\n]*\n([\s\S]*?)(?:\n```|$)/g)]
  const last = all.at(-1)?.[1]?.trim()
  return last || null
}

/**
 * The newest summary the session wrote for a request of this sheet, read from its events: the answers after the
 * last request, the last block among them (or the last answer when it has no block). `last` when nothing was said
 * to the session after that request; `block` when the summary is a handoff block (not just the last words).
 */
export function summaryAfterAsk(events: Ev[]): { asked: boolean; summary: string | null; last: boolean; block: boolean } {
  let at = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.k === 'user' && e.text.trimStart().startsWith(HANDOFF_ASK_HEAD)) {
      at = i
      break
    }
  }
  if (at < 0) return { asked: false, summary: null, last: false, block: false }
  // Nothing was asked of the session after it: the summary still says where the work stands.
  const last = !events.slice(at + 1).some((e) => e.k === 'user')
  const texts = events.slice(at + 1).flatMap((e) => (e.k === 'text' ? [e.text] : []))
  for (let i = texts.length - 1; i >= 0; i--) {
    const b = handoffOf(texts[i])
    if (b) return { asked: true, summary: b, last, block: true }
  }
  return { asked: true, summary: texts.length ? texts.at(-1)!.trim() || null : null, last, block: false }
}
