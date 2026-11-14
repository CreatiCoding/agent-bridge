// 다이내믹 아일랜드 (REQ-F-913): the 대화 모드 Live Activity, in the Dynamic Island and on the lock screen. The
// background stays the system's black; orange is in the symbol, the words and the keyline. A new phase swaps the
// symbol with the system's replace effect; while listening the waveform also plays, where the system lets it.

import ActivityKit
import SwiftUI
import WidgetKit

@main
struct BridgeLiveBundle: WidgetBundle {
  var body: some Widget { TalkLiveActivity() }
}

private let talkOrange = Color.orange

struct TalkLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: TalkAttributes.self) { ctx in
      LockView(title: ctx.attributes.title, started: ctx.attributes.started, phase: ctx.state.phase)
        .activityBackgroundTint(.black)
        .activitySystemActionForegroundColor(talkOrange)
    } dynamicIsland: { ctx in
      let phase = ctx.state.phase
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          PhaseSymbol(phase: phase).font(.title2).padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(timerInterval: ctx.attributes.started...Date.distantFuture, countsDown: false)
            .font(.callout.monospacedDigit()).foregroundStyle(talkOrange).multilineTextAlignment(.trailing)
            .frame(maxWidth: 64)
        }
        DynamicIslandExpandedRegion(.center) {
          Text("Claude와 대화 중").font(.headline).foregroundStyle(talkOrange).lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack(spacing: 6) {
            Text(phase.label).foregroundStyle(talkOrange).contentTransition(.opacity)
            if !ctx.attributes.title.isEmpty {
              Text("·").foregroundStyle(.secondary)
              Text(ctx.attributes.title).foregroundStyle(.secondary).lineLimit(1)
            }
          }
          .font(.subheadline)
        }
      } compactLeading: {
        PhaseSymbol(phase: phase)
      } compactTrailing: {
        Text(phase.label).font(.caption2.weight(.semibold)).foregroundStyle(talkOrange).lineLimit(1).fixedSize()
          .contentTransition(.opacity)
      } minimal: {
        PhaseSymbol(phase: phase)
      }
      .keylineTint(talkOrange)
    }
  }
}

/// The phase's symbol, orange; swapped with the replace effect when the phase changes.
struct PhaseSymbol: View {
  let phase: TalkAttributes.Phase
  var body: some View {
    Image(systemName: phase.symbol)
      .foregroundStyle(talkOrange)
      .contentTransition(.symbolEffect(.replace))
      .symbolEffect(.variableColor.iterative, options: .repeating, isActive: phase == .listening)
  }
}

struct LockView: View {
  let title: String
  let started: Date
  let phase: TalkAttributes.Phase
  var body: some View {
    HStack(spacing: 14) {
      PhaseSymbol(phase: phase).font(.title).frame(width: 40)
      VStack(alignment: .leading, spacing: 2) {
        Text("Claude와 대화 중 · \(phase.label)").font(.headline).foregroundStyle(talkOrange).contentTransition(.opacity)
        Text(title.isEmpty ? "Agent Bridge" : title).font(.subheadline).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
      }
      Spacer(minLength: 8)
      Text(timerInterval: started...Date.distantFuture, countsDown: false)
        .font(.title3.monospacedDigit()).foregroundStyle(talkOrange).multilineTextAlignment(.trailing).frame(maxWidth: 80)
    }
    .padding(16)
  }
}

#if DEBUG
#Preview("잠금 화면", as: .content, using: TalkAttributes(title: "agent-bridge", started: .now)) {
  TalkLiveActivity()
} contentStates: {
  TalkAttributes.ContentState(phase: .listening)
  TalkAttributes.ContentState(phase: .speaking)
  TalkAttributes.ContentState(phase: .thinking)
}
#endif
