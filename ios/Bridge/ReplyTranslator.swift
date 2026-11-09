// 영어 답 번역 (REQ-F-896). The page sends the English lines of an answer here and shows the Korean the phone
// gives back. Apple's Translation runs on the phone, so the answer never goes to a translation service; the
// English→Korean language pack is downloaded once, when the person presses 언어 받기 in 설정 → 이 기기.

import SwiftUI
import Translation
import WebKit

/// Takes the page's asks (window.webkit.messageHandlers.translate) and answers with window.bridgeTranslate(id, {...}).
final class ReplyTranslator {
  static let shared = ReplyTranslator()
  struct Job {
    let id: Int
    let texts: [String]
    /// Pressed in settings: may show the system's download sheet. An answer arriving never does.
    let prepare: Bool
  }
  weak var web: WKWebView?
  let jobs = AsyncStream.makeStream(of: Job.self)

  func ask(_ id: Int, texts: [String], prepare: Bool) {
    guard #available(iOS 18.0, *) else { return answer(id, ["status": "unsupported"]) }
    jobs.continuation.yield(Job(id: id, texts: texts, prepare: prepare))
  }

  func answer(_ id: Int, _ m: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: m), let json = String(data: data, encoding: .utf8) else { return }
    DispatchQueue.main.async { self.web?.evaluateJavaScript("window.bridgeTranslate?.(\(id), \(json))") }
  }
}

/// Holds the one translation session for the app's life. TranslationSession is only handed out by .translationTask,
/// so this empty view sits behind the web view and serves the page's asks from inside that task.
@available(iOS 18.0, *)
struct ReplyTranslatorHost: View {
  private static let en = Locale.Language(identifier: "en")
  private static let ko = Locale.Language(identifier: "ko")
  @State private var config = TranslationSession.Configuration(source: en, target: ko)

  var body: some View {
    Color.clear.frame(width: 1, height: 1).allowsHitTesting(false).accessibilityHidden(true)
      .translationTask(config) { session in
        let t = ReplyTranslator.shared
        for await job in t.jobs.stream {
          var status = await LanguageAvailability().status(from: Self.en, to: Self.ko)
          if status == .supported, job.prepare {
            // Asks the person to download the pack; returns once they agree, before it is on the phone.
            try? await session.prepareTranslation()
            status = await LanguageAvailability().status(from: Self.en, to: Self.ko)
          }
          let name = switch status {
          case .installed: "installed"
          case .supported: "download"
          default: "unsupported"
          }
          guard status == .installed, !job.texts.isEmpty else {
            t.answer(job.id, ["status": name])
            continue
          }
          let requests = job.texts.enumerated().map { TranslationSession.Request(sourceText: $1, clientIdentifier: String($0)) }
          do {
            var out = [String](repeating: "", count: job.texts.count)
            for r in try await session.translations(from: requests) {
              if let k = r.clientIdentifier, let i = Int(k), i < out.count { out[i] = r.targetText }
            }
            t.answer(job.id, ["status": name, "texts": out])
          } catch {
            t.answer(job.id, ["status": name, "error": error.localizedDescription])
          }
        }
      }
  }
}
