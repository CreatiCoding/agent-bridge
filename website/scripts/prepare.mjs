// Generates the pages that come from the rest of the repository, so they always match main:
// the changelog from ui/src/lib/changes.ts (the same list as Settings → 변경 기록), and the icon.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(site, '..')

// Node 22.18+ strips the types of a .ts file on import.
const { CHANGES } = await import(pathToFileURL(join(repo, 'ui/src/lib/changes.ts')).href)

const kinds = { added: '추가', changed: '바뀜', fixed: '고침', removed: '없앰', security: '보안' }
const scopes = { ui: '화면', server: '서버', agent: '에이전트' }
// The page is compiled as a Vue template: outside inline code, `<` and `{{` would be read as markup.
const escape = (s) =>
  s
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[<>{}]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '{': '&#123;', '}': '&#125;' })[c])))
    .join('')

// Versions worth knowing about before upgrading, one line each. Written by hand; the rest is generated.
const highlights = {
  '1.309': '서버를 Go 로 다시 작성했어요. 경로·환경 변수·데이터 형식은 그대로예요.',
  '1.305': '세션 터미널이 tmux 에서 [zeropty](https://github.com/CreatiCoding/zeropty) 로 바뀌었어요. 안 되면 tmux 를 써요.',
  '1.292': '에이전트가 믿는 서명 공개키를 `agent/keys.mjs` 로 뺐어요. 포크는 자기 키를 만들어요.',
  '1.277': '서버가 대화 사본·화면 기록·그림을 더 저장하지 않아요. 보내는 맥이 꺼져 있으면 옮길 수 없어요.',
  '1.271': 'git 원격 주소의 인증 정보, 지침 파일 본문, IP 를 서버에 남기지 않아요.',
}

const release = (r, latest) => {
  const commit = r.commit ? ` · 커밋 [\`${r.commit}\`](https://github.com/CreatiCoding/agent-bridge/commit/${r.commit})` : ''
  const out = [`## ${r.version}${latest ? ' <Badge type="tip" text="최신" />' : ''}`, '', `${r.date}${commit}`, '']
  for (const c of r.changes) {
    const scope = c.scope.map((s) => scopes[s] ?? s).join('·')
    out.push(`- <span class="rel-tag rel-${c.kind}">${kinds[c.kind] ?? c.kind}</span><span class="rel-scope">${scope}</span> ${escape(c.text)}`)
  }
  out.push('')
  return out
}

const RECENT = 15
const lines = [
  '---',
  'description: Agent Bridge 의 판별 변경 기록. 앱의 설정 → 변경 기록과 같은 목록이에요.',
  'editLink: false',
  'outline: { level: 2, label: 최근 판 }',
  '---',
  '',
  '# 변경 기록',
  '',
  '판마다 사람이 보는 변화를 적어요. 앱의 **설정 → 변경 기록**과 같은 목록이고, 판 번호는 저장소의 [`docs/SPEC.md`](https://github.com/CreatiCoding/agent-bridge/blob/main/docs/SPEC.md) 판과 같아요. 맥의 에이전트는 서버를 올리면 저절로 새 판으로 바뀌어요([끊기지 않는 배포](/guide/operate/deploy)).',
  '',
  '::: tip 크게 바뀐 것',
  ...Object.entries(highlights).map(([v, text]) => `- **[${v}](#${v.replace('.', '')})**: ${text}`),
  ':::',
  '',
]
CHANGES.slice(0, RECENT).forEach((r, i) => lines.push(...release(r, i === 0)))

// Older releases, folded by month.
const months = new Map()
for (const r of CHANGES.slice(RECENT)) {
  const month = r.date.slice(0, 7)
  if (!months.has(month)) months.set(month, [])
  months.get(month).push(r)
}
lines.push('## 지난 판', '')
for (const [month, releases] of months) {
  const [y, m] = month.split('-')
  lines.push(`::: details ${y}년 ${Number(m)}월 (${releases.length}개 판, ${releases.at(-1).version} ~ ${releases[0].version})`, '')
  for (const r of releases) lines.push(...release(r, false).map((l) => l.replace(/^## /, '#### ')))
  lines.push(':::', '')
}
writeFileSync(join(site, 'src/changelog.md'), lines.join('\n'))

mkdirSync(join(site, 'src/public'), { recursive: true })
copyFileSync(join(repo, 'web/icon.svg'), join(site, 'src/public/icon.svg'))
console.log(`changelog: ${CHANGES.length} releases`)
