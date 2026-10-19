// What leaves a Mac and what the server keeps: remote addresses without sign-in parts, notes without their text (REQ-S-073).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripCreds, hideRemotes, hidePaths, cleanFolder } from '../../agent/scrub.mjs'

test('stripCreds: https 주소의 user:token@ 은 통째로 빠진다', () => {
  assert.equal(stripCreds('https://me:ghp_abc123@github.com/o/r.git'), 'https://github.com/o/r.git')
  assert.equal(stripCreds('https://x-access-token:ghs_xyz@github.com/o/r'), 'https://github.com/o/r')
  assert.equal(stripCreds('https://oauth2@gitlab.example/o/r.git'), 'https://gitlab.example/o/r.git')
  assert.equal(stripCreds('http://u:p@10.0.0.1:8080/r.git'), 'http://10.0.0.1:8080/r.git')
})

test('stripCreds: ssh:// 는 사용자만 남기고 비밀번호를 뺀다, scp 꼴은 그대로', () => {
  assert.equal(stripCreds('ssh://git:secret@host.example/o/r.git'), 'ssh://git@host.example/o/r.git')
  assert.equal(stripCreds('ssh://git@host.example/o/r.git'), 'ssh://git@host.example/o/r.git')
  assert.equal(stripCreds('git@github.com:o/r.git'), 'git@github.com:o/r.git')
  assert.equal(stripCreds('https://github.com/o/r.git'), 'https://github.com/o/r.git')
  assert.equal(stripCreds(null), null)
})

test('hideRemotes: git 오류 글 속의 주소에서도 토큰이 빠진다', () => {
  const err = "fatal: unable to access 'https://me:ghp_abc123@github.com/o/r.git/': The requested URL returned error: 403"
  assert.ok(!hideRemotes(err).includes('ghp_abc123'))
  assert.match(hideRemotes(err), /https:\/\/github\.com\/o\/r\.git/)
  assert.equal(hideRemotes(undefined), '')
})

test('hidePaths: 홈 폴더 경로는 (경로) 로', () => {
  assert.equal(hidePaths('열지 못함: /Users/kim/work/a.txt'), '열지 못함: (경로)')
  assert.equal(hidePaths("'~/x/y' 없음"), "'(경로)' 없음")
})

test('cleanFolder: 원격 주소의 인증 정보와 노트 본문이 빠지고 나머지는 그대로', () => {
  const folder = {
    git: false,
    at: 1,
    files: { 'CLAUDE.md': '비밀 메모', 'SESSION-a.md': '넘김' },
    repos: [
      { dir: '.', branch: 'f', sha: 'abc', origin: 'https://me:tok@github.com/o/r.git', push: "failed: unable to access 'https://me:tok@github.com/o/r.git/'", pr: { url: 'https://github.com/o/r/pull/1', number: 1 } },
      { dir: 'b', origin: 'git@github.com:o/b.git', push: 'ok' },
    ],
  }
  const out = cleanFolder(folder)
  assert.deepEqual(out.files, {})
  assert.equal(out.repos[0].origin, 'https://github.com/o/r.git')
  assert.ok(!out.repos[0].push.includes('tok'))
  assert.deepEqual(out.repos[0].pr, folder.repos[0].pr)
  assert.equal(out.repos[1].origin, 'git@github.com:o/b.git')
  assert.equal(out.at, 1)
  // The input is left as it was: the move still needs the notes from the Mac's answer.
  assert.equal(folder.files['CLAUDE.md'], '비밀 메모')
  assert.equal(cleanFolder(null), null)
})
