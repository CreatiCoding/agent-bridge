// 다이내믹 아일랜드 (REQ-F-913): what the app and the BridgeLive widget extension share about a 대화 모드 Live
// Activity. The app starts it when 대화 모드 starts (always in front), updates it from the page's state while the
// app goes on in the background (REQ-F-912), and ends it with the talk.

import ActivityKit
import Foundation

struct TalkAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// listening, speaking (Claude reads the answer) or thinking (sent, the answer not in yet).
    var phase: Phase
  }

  enum Phase: String, Codable, Hashable {
    case listening, speaking, thinking

    /// SF Symbol for the phase.
    var symbol: String {
      switch self {
      case .listening: "waveform"
      case .speaking: "speaker.wave.2.fill"
      case .thinking: "ellipsis"
      }
    }

    var label: String {
      switch self {
      case .listening: "듣는 중"
      case .speaking: "말하는 중"
      case .thinking: "생각 중"
      }
    }
  }

  /// The session's name, as the page shows it.
  var title: String
  /// When the talk started: the lock screen and the expanded island count up from it.
  var started: Date
}
