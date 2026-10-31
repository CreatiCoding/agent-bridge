import { defineConfig, type DefaultTheme } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const repo = 'https://github.com/CreatiCoding/agent-bridge'

// GitHub's heading ids, so anchors look the same here and in the repository.
function slugify(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-')
}

const badge = (text: string, label: string) => `${text} <span class="sb-badge">${label}</span>`

const guide: DefaultTheme.SidebarItem[] = [
  {
    text: '처음이라면',
    items: [
      { text: '소개', link: '/guide/introduction' },
      { text: '시작하기', link: '/guide/getting-started' },
      { text: '지원 환경', link: '/guide/requirements' },
    ],
  },
  {
    text: '개념',
    items: [
      { text: '구성과 연결', link: '/guide/concepts/architecture' },
      { text: '세션의 일생', link: '/guide/concepts/sessions' },
      { text: '옮기기와 작업 폴더 싱크', link: '/guide/concepts/sync' },
      { text: '보안 모델', link: '/guide/concepts/security' },
    ],
  },
  {
    text: '사용 가이드',
    items: [
      { text: '폰에서 세션 다루기', link: '/guide/use/sessions' },
      { text: '세션 옮기기', link: '/guide/use/move' },
      { text: '맥의 대화 가져오기', link: '/guide/use/adopt' },
      { text: '목록 정리와 잠금', link: '/guide/use/organize' },
      { text: '알림과 웹 푸시', link: '/guide/use/notifications' },
      { text: '음성 입력', link: '/guide/use/voice' },
      { text: '기기 상태와 디스크 관리', link: '/guide/use/devices' },
      { text: 'Slack 플러그인', link: '/guide/use/slack' },
      { text: 'Linux 서버 연결하기', link: '/guide/use/linux' },
      { text: badge('맥을 늘 연결해 두기', '선택'), link: '/guide/use/always-on' },
    ],
  },
  {
    text: '운영',
    items: [
      { text: '서버 올리기', link: '/guide/operate/self-host' },
      { text: '접근 관리와 운영 화면', link: '/guide/operate/admin' },
      { text: '설정 파일 bridge.yaml', link: '/guide/operate/config' },
      { text: badge('알림 웹훅과 훅', '선택'), link: '/guide/operate/hooks' },
      { text: badge('익스텐션 두기와 만들기', '선택'), link: '/guide/operate/extensions' },
      { text: '에이전트 서명 키', link: '/guide/operate/signing' },
      { text: '끊기지 않는 배포', link: '/guide/operate/deploy' },
      { text: '문제 해결', link: '/guide/operate/troubleshooting' },
    ],
  },
]

const reference: DefaultTheme.SidebarItem[] = [
  { text: '레퍼런스 안내', link: '/reference/' },
  {
    text: '기기 (에이전트)',
    items: [
      { text: '설치 스크립트와 에이전트 명령', link: '/reference/agent-cli' },
      { text: '점검 항목', link: '/reference/checks' },
      { text: '기기의 파일과 경로', link: '/reference/files' },
    ],
  },
  {
    text: '서버',
    items: [
      { text: 'bridge.yaml 키', link: '/reference/config' },
      { text: '환경 변수', link: '/reference/env' },
      { text: '주소와 HTTP API', link: '/reference/routes' },
      { text: '플러그인 API (서버 안, Slack)', link: '/reference/plugin-api' },
      { text: '익스텐션 API (화면, JS)', link: '/reference/extension-api' },
    ],
  },
  {
    text: '화면과 동작',
    items: [
      { text: '세션 상태와 카드', link: '/reference/states' },
      { text: '한도와 시간', link: '/reference/limits' },
      { text: '용어집', link: '/reference/glossary' },
    ],
  },
]

export default withMermaid(defineConfig({
  mermaid: { themeVariables: { fontSize: '15px', fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif' } },
  lang: 'ko',
  title: 'Agent Bridge',
  description: '맥에서 도는 Claude Code 세션을 폰에서 다루고, 맥 사이로 옮기는 셀프호스팅 시스템',
  cleanUrls: true,
  appearance: 'dark',
  head: [
    ['link', { rel: 'icon', href: '/icon.svg', type: 'image/svg+xml' }],
    ['meta', { property: 'og:image', content: 'https://agent-bridge.pubdoc.dev/social.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  markdown: {
    anchor: { slugify },
    theme: { light: 'github-light', dark: 'github-dark' },
  },
  // Each page's own description becomes its meta description.
  transformPageData(page) {
    const description = page.frontmatter.description
    if (description) page.description = description
  },
  themeConfig: {
    logo: '/icon.svg',
    siteTitle: 'Agent Bridge',
    nav: [
      { text: '가이드', link: '/guide/introduction', activeMatch: '/guide/' },
      { text: '레퍼런스', link: '/reference/', activeMatch: '/reference/' },
      { text: '변경 기록', link: '/changelog' },
    ],
    sidebar: { '/guide/': guide, '/reference/': reference },
    socialLinks: [{ icon: 'github', link: repo }],
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '검색', buttonAriaLabel: '검색' },
          modal: {
            noResultsText: '결과가 없어요',
            resetButtonTitle: '지우기',
            footer: { selectText: '선택', navigateText: '이동', closeText: '닫기' },
          },
        },
      },
    },
    outline: { level: [2, 3], label: '이 페이지에서' },
    // The pattern function is serialized into the client bundle, so it cannot use anything outside itself.
    editLink: {
      pattern: ({ filePath }) => `https://github.com/CreatiCoding/agent-bridge/edit/main/website/src/${filePath}`,
      text: 'GitHub에서 이 페이지 고치기',
    },
    docFooter: { prev: '이전', next: '다음' },
    footer: { message: 'AGPL-3.0-only 라이선스로 배포해요.', copyright: 'Agent Bridge' },
    darkModeSwitchLabel: '테마',
    lightModeSwitchTitle: '밝은 테마로',
    darkModeSwitchTitle: '어두운 테마로',
    sidebarMenuLabel: '메뉴',
    returnToTopLabel: '맨 위로',
    notFound: { title: '페이지를 찾을 수 없어요', quote: '주소가 바뀌었거나 없는 페이지예요.', linkText: '처음으로' },
  },
}))
