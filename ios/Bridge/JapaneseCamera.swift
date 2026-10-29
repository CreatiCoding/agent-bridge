// 카메라 번역 (REQ-F-808, 임시 시험 기능). Opened from the app icon's long-press menu: the back camera reads Japanese
// with Vision and puts the Korean over each line. Both run on the phone, so it works offline once the system's
// Japanese→Korean language pack is there (asked for once, the first time, while online).

import AVFoundation
import SwiftUI
import Translation
import Vision

/// Opens the camera screen from the home-screen quick action.
final class Lab: ObservableObject {
  static let shared = Lab()
  static let cameraAction = "dev.creco.bridge.jp-camera"
  @Published var camera = false

  func handle(_ item: UIApplicationShortcutItem) -> Bool {
    guard item.type == Self.cameraAction else { return false }
    camera = true
    return true
  }
}

/// The quick action arrives here while the app is running; at launch it comes with the scene's options instead.
final class SceneDelegate: NSObject, UIWindowSceneDelegate {
  func windowScene(_ s: UIWindowScene, performActionFor item: UIApplicationShortcutItem, completionHandler done: @escaping (Bool) -> Void) {
    done(Lab.shared.handle(item))
  }
}

struct CameraScreen: View {
  var body: some View {
    if #available(iOS 18.0, *) {
      JapaneseCamera()
    } else {
      // The translation API the screen uses came in iOS 18.
      Closable { Text("카메라 번역은 iOS 18 이상에서 돼요.").foregroundStyle(.white) }
    }
  }
}

/// A line of Japanese on the frame. `box` is 0…1 of the upright frame, origin top left.
struct SeenLine: Identifiable {
  let id: Int
  let text: String
  let box: CGRect
}

/// Reads the back camera, about twice a second, and hands the Japanese lines it found to `found`.
final class JapaneseReader: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  let session = AVCaptureSession()
  @Published var lines: [SeenLine] = []
  @Published var frame = CGSize(width: 720, height: 1280)
  @Published var denied = false
  var found: (([String]) -> Void)?
  private let queue = DispatchQueue(label: "jp-camera")
  private var last = Date.distantPast
  private var held = false

  func start() {
    AVCaptureDevice.requestAccess(for: .video) { ok in
      DispatchQueue.main.async { self.denied = !ok }
      guard ok else { return }
      self.queue.async {
        self.configure()
        self.session.startRunning()
      }
    }
  }

  func stop() { queue.async { self.session.stopRunning() } }

  /// Held: the last lines stay on screen to be read.
  func hold(_ on: Bool) { queue.async { self.held = on } }

  private func configure() {
    guard session.inputs.isEmpty,
          let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
          let input = try? AVCaptureDeviceInput(device: cam) else { return }
    session.beginConfiguration()
    session.sessionPreset = .hd1280x720
    if session.canAddInput(input) { session.addInput(input) }
    let out = AVCaptureVideoDataOutput()
    out.alwaysDiscardsLateVideoFrames = true
    out.setSampleBufferDelegate(self, queue: queue)
    if session.canAddOutput(out) { session.addOutput(out) }
    // Upright frames, so Vision's boxes line up with the portrait preview.
    if let c = out.connection(with: .video), c.isVideoRotationAngleSupported(90) { c.videoRotationAngle = 90 }
    session.commitConfiguration()
    if (try? cam.lockForConfiguration()) != nil {
      if cam.isFocusModeSupported(.continuousAutoFocus) { cam.focusMode = .continuousAutoFocus }
      cam.unlockForConfiguration()
    }
  }

  func captureOutput(_ o: AVCaptureOutput, didOutput b: CMSampleBuffer, from c: AVCaptureConnection) {
    guard !held, Date().timeIntervalSince(last) > 0.4, let px = CMSampleBufferGetImageBuffer(b) else { return }
    last = Date()
    let size = CGSize(width: CVPixelBufferGetWidth(px), height: CVPixelBufferGetHeight(px))
    let req = VNRecognizeTextRequest()
    // Japanese is read only at the accurate level.
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["ja-JP"]
    req.usesLanguageCorrection = true
    try? VNImageRequestHandler(cvPixelBuffer: px, orientation: .up).perform([req])
    var seen: [SeenLine] = []
    for o in req.results ?? [] {
      // Lines with no kana or kanji (numbers, Latin) are left alone.
      guard let t = o.topCandidates(1).first, t.confidence > 0.3,
            t.string.range(of: "[\\p{Hiragana}\\p{Katakana}\\p{Han}]", options: .regularExpression) != nil else { continue }
      let r = o.boundingBox
      seen.append(SeenLine(id: seen.count, text: t.string, box: CGRect(x: r.minX, y: 1 - r.maxY, width: r.width, height: r.height)))
    }
    DispatchQueue.main.async {
      guard !self.held else { return }
      self.frame = size
      self.lines = seen
      self.found?(seen.map(\.text))
    }
  }
}

@available(iOS 18.0, *)
struct JapaneseCamera: View {
  @StateObject private var reader = JapaneseReader()
  @State private var korean: [String: String] = [:]
  @State private var held = false
  @State private var status = "번역 준비 중…"
  @State private var failed = false
  @State private var config = TranslationSession.Configuration(source: Locale.Language(identifier: "ja"), target: Locale.Language(identifier: "ko"))
  // Only the newest lines wait: a frame read while the last one was being translated is already old.
  @State private var texts = AsyncStream.makeStream(of: [String].self, bufferingPolicy: .bufferingNewest(1))

  var body: some View {
    Closable {
      ZStack {
        Preview(session: reader.session).ignoresSafeArea()
        GeometryReader { g in
          ForEach(reader.lines) { l in
            let r = rect(l.box, g.size)
            label(l).frame(width: max(r.width, 60), height: max(r.height, 18)).position(x: r.midX, y: r.midY)
          }
        }.ignoresSafeArea()
        VStack {
          Spacer()
          list
        }
      }
    } top: {
      Text(status).font(.footnote).padding(.horizontal, 10).padding(.vertical, 6)
        .background(.black.opacity(0.6), in: Capsule()).foregroundStyle(failed ? .orange : .white)
    }
    .onAppear {
      let c = texts.continuation
      reader.found = { c.yield($0) }
      reader.start()
    }
    .onDisappear { reader.stop() }
    .task { await checkLanguage() }
    .translationTask(config) { session in
      do {
        // Asks to download the language pack if it is not on the phone yet; after that no network is needed.
        try await session.prepareTranslation()
        await MainActor.run { status = "오프라인으로 번역해요 · 일본어 → 한국어"; failed = false }
      } catch {
        await MainActor.run { status = "언어 받기를 못 했어요. 인터넷에 연결해 한 번 받아 주세요"; failed = true }
        return
      }
      for await lines in texts.stream {
        let known = await MainActor.run { korean }
        let todo = Array(Set(lines)).filter { known[$0] == nil }
        guard !todo.isEmpty else { continue }
        let requests = todo.map { TranslationSession.Request(sourceText: $0, clientIdentifier: $0) }
        guard let done = try? await session.translations(from: requests) else { continue }
        await MainActor.run {
          for r in done { if let k = r.clientIdentifier { korean[k] = r.targetText } }
        }
      }
    }
    .alert("카메라를 쓸 수 없어요", isPresented: $reader.denied) {
      Button("설정 열기") { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }
      Button("닫기", role: .cancel) {}
    } message: {
      Text("설정 → Agent Bridge 에서 카메라를 허용해 주세요.")
    }
  }

  private var list: some View {
    VStack(spacing: 10) {
      if !reader.lines.isEmpty {
        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(reader.lines) { l in
              VStack(alignment: .leading, spacing: 2) {
                Text(korean[l.text] ?? "…").font(.body.weight(.semibold))
                Text(l.text).font(.caption).foregroundStyle(.secondary)
              }
              .frame(maxWidth: .infinity, alignment: .leading)
            }
          }.padding(12)
        }
        .frame(maxHeight: 220)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
      }
      Button(held ? "다시 보기" : "멈춤") {
        held.toggle()
        reader.hold(held)
      }
      .font(.headline).padding(.horizontal, 28).padding(.vertical, 12)
      .background(.white, in: Capsule()).foregroundStyle(.black)
    }
    .padding(.horizontal, 16).padding(.bottom, 12)
  }

  private func label(_ l: SeenLine) -> some View {
    Text(korean[l.text] ?? l.text)
      .font(.system(size: 40, weight: .semibold)).minimumScaleFactor(0.2).lineLimit(2)
      .foregroundStyle(.white).padding(.horizontal, 3)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background((korean[l.text] == nil ? Color.gray : Color.blue).opacity(0.75), in: RoundedRectangle(cornerRadius: 4))
  }

  /// A box of the frame on screen, where the preview fills the screen and crops what does not fit.
  private func rect(_ b: CGRect, _ view: CGSize) -> CGRect {
    let f = reader.frame
    let scale = max(view.width / f.width, view.height / f.height)
    let dx = (view.width - f.width * scale) / 2, dy = (view.height - f.height * scale) / 2
    return CGRect(x: b.minX * f.width * scale + dx, y: b.minY * f.height * scale + dy,
                  width: b.width * f.width * scale, height: b.height * f.height * scale)
  }

  private func checkLanguage() async {
    let s = await LanguageAvailability().status(from: Locale.Language(identifier: "ja"), to: Locale.Language(identifier: "ko"))
    switch s {
    case .installed: status = "오프라인으로 번역해요 · 일본어 → 한국어"
    case .supported: status = "처음 한 번 언어 받기가 필요해요(인터넷)"
    default:
      status = "이 기기는 일본어 → 한국어 번역을 지원하지 않아요"
      failed = true
    }
  }
}

/// Black full screen with a close button and an optional line at the top.
struct Closable<Content: View, Top: View>: View {
  @Environment(\.dismiss) private var dismiss
  let content: Content
  let top: Top

  init(@ViewBuilder content: () -> Content, @ViewBuilder top: () -> Top) {
    self.content = content()
    self.top = top()
  }

  var body: some View {
    ZStack(alignment: .top) {
      Color.black.ignoresSafeArea()
      content
      HStack {
        Button { dismiss() } label: {
          Image(systemName: "xmark").font(.headline).padding(12).background(.black.opacity(0.6), in: Circle()).foregroundStyle(.white)
        }
        .accessibilityLabel("닫기")
        Spacer()
        top
        Spacer()
        Color.clear.frame(width: 44, height: 44)
      }
      .padding(.horizontal, 16)
    }
  }
}

extension Closable where Top == EmptyView {
  init(@ViewBuilder content: () -> Content) {
    self.init(content: content, top: { EmptyView() })
  }
}

/// The camera's own preview layer, turned upright like the frames Vision reads.
struct Preview: UIViewRepresentable {
  let session: AVCaptureSession

  final class Layer: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    override func layoutSubviews() {
      super.layoutSubviews()
      if let c = preview.connection, c.isVideoRotationAngleSupported(90) { c.videoRotationAngle = 90 }
    }
  }

  func makeUIView(context: Context) -> Layer {
    let v = Layer()
    v.preview.session = session
    v.preview.videoGravity = .resizeAspectFill
    return v
  }

  func updateUIView(_ v: Layer, context: Context) { v.setNeedsLayout() }
}
