// 알림이 오는 때 (REQ-F-866): the words under the push switch say what the server actually pushes. When a push
// trigger is added or dropped on the server, this test fails until ui/src/components/push.tsx says so too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = new URL('../../', import.meta.url).pathname
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

test('서버가 푸시하는 알림 자리가 설명과 같다', () => {
  const lines = readdirSync(path.join(ROOT, 'server'))
    .filter((n) => n.endsWith('.go') && !n.endsWith('_test.go'))
    .flatMap((n) => read(`server/${n}`).split('\n').map((l) => [n, l]))
    .filter(([, l]) => /\baddNotice\(uid|\baddNotice\(meta/.test(l))
  const pushed = lines.filter(([, l]) => /"push": *(true|"always")|permissionNotice\(/.test(l)).map(([n]) => n)
  // agentmsg: card (permission, other) and their reminders = 4; delegate: hand-off, sudo, system dialog = 3;
  // tidy: stop notice, day summary = 2; api1: the dev-only test notice = 1.
  assert.deepEqual(
    pushed.sort(),
    ['agentmsg.go', 'agentmsg.go', 'agentmsg.go', 'agentmsg.go', 'api1.go', 'delegate.go', 'delegate.go', 'delegate.go', 'tidy.go', 'tidy.go'],
  )
  // A background task that ended is listed, not pushed.
  const task = lines.find(([n, l]) => n === 'eventlog.go' && /"\|" \+ status/.test(l))
  assert.ok(task && !/"push"/.test(task[1]))
})

test('설정과 가이드가 같은 말을 한다', () => {
  const push = read('ui/src/components/push.tsx')
  for (const w of ['권한 요청', '질문', '플랜 승인', '관리자 비밀번호', '시스템 허락 창', '다른 맥에 일을 맡겼을 때', '세션 정리', '45초', '알림 목록에만'])
    assert.ok(push.includes(w), w)
  assert.match(read('ui/src/pages/settings.tsx'), /<PushWhen \/>/)
  const guide = read('ui/src/pages/guide.tsx')
  assert.ok(!guide.includes('권한 요청과 답이'), '답(턴 끝)은 푸시하지 않는다')
  assert.ok(guide.includes('설정 → 화면·알림'))
})
