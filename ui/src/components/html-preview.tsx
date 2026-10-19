// HTML in an answer (a ```html block, or an answer that is a whole document) drawn read-only: in a frame
// with no scripts, no network, nothing from this site.
import { useRef, useState } from 'react'
import { CodeBlock } from '../lib/markdown'
import { Button, Icon } from '../kit'
import { Sheet } from '../kit/overlay'

const POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`

function Frame({ html, tall }: { html: string; tall?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(tall ? 640 : 220)
  return (
    <iframe
      ref={frame}
      className="html-frame"
      title="HTML 미리보기"
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={`${POLICY}${html}`}
      style={{ height: tall ? '70dvh' : height }}
      onLoad={() => {
        // Same origin (sandboxed, but readable): fit the frame to what it holds, up to a limit.
        const doc = frame.current?.contentDocument
        if (!tall && doc) setHeight(Math.min(480, Math.max(80, doc.documentElement.scrollHeight)))
      }}
    />
  )
}

export function HtmlPreview({ html }: { html: string }) {
  const [code, setCode] = useState(false)
  const [big, setBig] = useState(false)
  return (
    <div className="html-prev">
      <div className="html-bar">
        <Icon name="doc" />
        <span className="grow">HTML 미리보기</span>
        <Button size="sm" tone="ghost" onClick={() => setBig(true)}>
          크게 보기
        </Button>
        <Button size="sm" tone="ghost" onClick={() => setCode(!code)}>
          {code ? '미리보기' : '코드 보기'}
        </Button>
      </div>
      {code ? <CodeBlock code={html} lang="html" /> : <Frame html={html} />}
      <Sheet open={big} onClose={() => setBig(false)} title="HTML 미리보기" wide>
        <Frame html={html} tall />
      </Sheet>
    </div>
  )
}

export const isHtmlDocument = (text: string) => /^\s*<(!doctype html|html)[\s>]/i.test(text)
