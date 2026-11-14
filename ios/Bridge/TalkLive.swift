// 앱에서 백그라운드 대화 (REQ-F-912)·다이내믹 아일랜드 (REQ-F-913), the app's half. The page tells the app what
// 대화 모드 does (window.webkit.messageHandlers.talk: start, update, end); the app shows it as a Live Activity and
// keeps it up to date locally (no push: the app goes on in the background through the audio background mode while
// WebKit records and plays). The sound itself stays WebKit's: the app does not touch AVAudioSession.

import ActivityKit
import Foundation
import UIKit

@MainActor
final class TalkLive {
  static let shared = TalkLive()
  private var activity: Activity<TalkAttributes>?
  private var title = ""

  /// A message from the page (its origin already checked).
  func handle(_ body: [String: Any]) {
    let phase = (body["phase"] as? String).flatMap(TalkAttributes.Phase.init(rawValue:)) ?? .listening
    switch body["op"] as? String {
    case "start": start(String((body["title"] as? String ?? "").prefix(80)), phase)
    case "update": update(phase)
    case "end": end()
    default: break
    }
  }

  private func start(_ title: String, _ phase: TalkAttributes.Phase) {
    end()
    self.title = title
    // Only in front: iOS refuses to start one from the background, and the person may have turned them off.
    guard ActivityAuthorizationInfo().areActivitiesEnabled, UIApplication.shared.applicationState != .background else {
      NSLog("talk live activity: not started (allowed \(ActivityAuthorizationInfo().areActivitiesEnabled))")
      return
    }
    do {
      activity = try Activity.request(
        attributes: TalkAttributes(title: title, started: .now),
        content: ActivityContent(state: .init(phase: phase), staleDate: nil),
        pushType: nil)
    } catch {
      NSLog("talk live activity: \(error.localizedDescription)")
      activity = nil
    }
  }

  private func update(_ phase: TalkAttributes.Phase) {
    // Lost (the person swiped it away, or it was never allowed): started again only while the app is in front.
    guard let a = activity, a.activityState == .active else {
      if UIApplication.shared.applicationState == .active { start(title, phase) }
      return
    }
    Task { await a.update(ActivityContent(state: .init(phase: phase), staleDate: nil)) }
  }

  /// The talk ended (or the page that held it is gone): the island goes at once.
  func end() {
    let a = activity
    activity = nil
    guard let a else { return }
    Task { await a.end(nil, dismissalPolicy: .immediate) }
  }

  /// Every talk activity, this run's or one left by a run that was killed (launch, web process gone, quitting).
  nonisolated static func endAll(wait: Bool = false) {
    let done = DispatchSemaphore(value: 0)
    Task.detached {
      for a in Activity<TalkAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
      done.signal()
    }
    // Quitting: the process ends right after, so it waits a little for the system to take the end.
    if wait { _ = done.wait(timeout: .now() + 1.5) }
  }

  #if DEBUG
  /// The page's own loads do not end the demo one.
  private var demoing = false
  /// For screenshots in the simulator: `-talkDemo listening|speaking|thinking` starts one without the page.
  func demo() {
    let args = ProcessInfo.processInfo.arguments
    guard let i = args.firstIndex(of: "-talkDemo"), i + 1 < args.count else { return }
    demoing = true
    start("agent-bridge", TalkAttributes.Phase(rawValue: args[i + 1]) ?? .listening)
  }
  #endif

  func reset() {
    #if DEBUG
    if demoing { return }
    #endif
    activity = nil
    Self.endAll()
  }
}
