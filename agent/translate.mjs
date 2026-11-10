// 맥 언어팩 번역 (REQ-F-897): English lines to Korean with macOS's own Translation language pack, for a browser that
// has no on-device translator of its own. A small Swift program (below) is built once with the Mac's swiftc into
// ~/.claude-bridge/bin and kept running: lines go in as JSON on stdin and come back on stdout. Nothing leaves the Mac.
// macOS 26 or later: TranslationSession(installedSource:target:) outside an app came there. The language pack is
// downloaded in 시스템 설정 → 일반 → 언어 및 지역 → 번역 언어; this program never downloads.
import { spawn, execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SWIFT = `import Foundation
import Translation

@main
struct KoTranslate {
  static func main() async {
    let en = Locale.Language(identifier: "en"), ko = Locale.Language(identifier: "ko")
    var session: TranslationSession?
    while let line = readLine() {
      guard let data = line.data(using: .utf8),
            let job = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let id = job["id"] as? Int else { continue }
      let texts = job["texts"] as? [String] ?? []
      var out: [String: Any] = ["id": id]
      let status = await LanguageAvailability().status(from: en, to: ko)
      if status != .installed {
        out["status"] = status == .supported ? "download" : "unsupported"
      } else {
        out["status"] = "installed"
        if !texts.isEmpty {
          if session == nil { session = TranslationSession(installedSource: en, target: ko) }
          let requests = texts.enumerated().map { TranslationSession.Request(sourceText: $1, clientIdentifier: String($0)) }
          do {
            var done = [String](repeating: "", count: texts.count)
            for r in try await session!.translations(from: requests) {
              if let k = r.clientIdentifier, let i = Int(k), i < done.count { done[i] = r.targetText }
            }
            out["texts"] = done
          } catch {
            out["error"] = String(describing: error)
            session = nil
          }
        }
      }
      if let d = try? JSONSerialization.data(withJSONObject: out), let s = String(data: d, encoding: .utf8) {
        print(s)
        fflush(stdout)
      }
    }
  }
}
`

/** macOS 26 is Darwin 25. */
export const canTranslate = (platform = process.platform, release = os.release()) => platform === 'darwin' && Number(release.split('.')[0]) >= 25

const err = (code, message) => Object.assign(new Error(message), { code })

/**
 * One running translator per agent. `dir` is where the built program is kept (~/.claude-bridge/bin); a new SWIFT
 * gets a new name, so an agent update builds again.
 */
export class MacTranslator {
  constructor({ dir, log = () => {}, run = spawn, build = execFile, can = canTranslate } = {}) {
    this.can = can
    this.dir = dir
    this.log = log
    this.run = run
    this.buildFn = build
    this.proc = null
    this.next = 1
    this.waiting = new Map()
    this.buf = ''
    this.ready = null
  }

  bin() {
    return path.join(this.dir, `ko-translate-${crypto.createHash('sha1').update(SWIFT).digest('hex').slice(0, 10)}`)
  }

  /** Builds the program once (a few seconds the first time). */
  build() {
    const out = this.bin()
    if (fs.existsSync(out)) return Promise.resolve(out)
    this.ready ??= new Promise((resolve, reject) => {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const src = `${out}.swift`
      fs.writeFileSync(src, SWIFT)
      const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos26.0`
      this.buildFn('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', target, src, '-o', `${out}.tmp`], { timeout: 180_000 }, (e, _so, se) => {
        fs.rmSync(src, { force: true })
        if (e) {
          this.ready = null
          this.log('error', 'translate', `번역기 빌드 실패: ${String(se || e.message).slice(0, 400)}`)
          return reject(err('build', '맥에서 번역기를 만들지 못했어요(Xcode 명령줄 도구가 필요해요)'))
        }
        fs.renameSync(`${out}.tmp`, out)
        resolve(out)
      })
    })
    return this.ready
  }

  async start() {
    if (this.proc) return this.proc
    const bin = await this.build()
    if (this.proc) return this.proc
    const p = this.run(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    this.proc = p
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (d) => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        try {
          const m = JSON.parse(line)
          this.waiting.get(m.id)?.(m)
          this.waiting.delete(m.id)
        } catch {}
      }
    })
    const gone = () => {
      if (this.proc !== p) return
      this.proc = null
      this.buf = ''
      for (const f of this.waiting.values()) f({ error: '번역기가 멈췄어요' })
      this.waiting.clear()
    }
    p.on('exit', gone)
    p.on('error', gone)
    return p
  }

  /** {status, texts?}: status installed | download | unsupported. Throws with a code on failure. */
  async translate(texts, wait = 25_000) {
    if (!this.can()) throw err('unsupported', '이 맥은 언어팩 번역을 쓸 수 없어요(macOS 26 이상)')
    const p = await this.start()
    const id = this.next++
    const m = await new Promise((resolve) => {
      const timer = setTimeout(() => this.waiting.delete(id) && resolve({ error: '번역이 오래 걸려요' }), wait)
      this.waiting.set(id, (r) => (clearTimeout(timer), resolve(r)))
      p.stdin.write(`${JSON.stringify({ id, texts })}\n`)
    })
    if (m.error) throw err('error', String(m.error).slice(0, 300))
    return { status: m.status, ...(Array.isArray(m.texts) ? { texts: m.texts } : {}) }
  }

  stop() {
    this.proc?.kill()
    this.proc = null
  }
}
