// claude-bridge iOS 앱 (REQ-F-756). A thin shell around the web page: a home-screen web app asks for the
// microphone every time it is opened again, and an app is asked once (the system remembers it under 설정 → bridge).
// The page's own microphone requests are granted here without a second prompt.

import AuthenticationServices
import SwiftUI
import UserNotifications
import WebKit

let home = URL(string: "https://bridge.creco.dev/")!
/** Pages that stay in the app: the bridge itself and GitHub's sign-in. Anything else opens in Safari. */
let inApp: Set<String> = ["bridge.creco.dev", "github.com"]

@main
struct BridgeApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
  var body: some Scene {
    WindowGroup {
      // The keyboard does not shrink the web view: WebKit pans what is seen, as in Safari, and the page puts its input
      // on the keyboard. Shrinking it as well moved the page twice, hiding the input behind the keyboard for a moment.
      Web().ignoresSafeArea(.container, edges: .bottom).ignoresSafeArea(.keyboard)
    }
  }
}

struct Web: UIViewRepresentable {
  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> WKWebView {
    let c = WKWebViewConfiguration()
    c.allowsInlineMediaPlayback = true
    c.mediaTypesRequiringUserActionForPlayback = []
    c.websiteDataStore = .default()
    // Apple로 로그인 (REQ-F-772): the sign-in page's button asks for an Apple ID through this.
    c.userContentController.add(context.coordinator, name: "appleSignIn")
    // 앱 알림 (REQ-F-774): the settings switch asks for the system's permission and the APNs token through this.
    c.userContentController.add(context.coordinator, name: "push")
    // The page reads the app's version from here to show it in 설정 → 이 기기 (REQ-F-765). Appended, so the
    // default "Mobile/…" that sites look for stays.
    let info = Bundle.main.infoDictionary
    let version = info?["CFBundleShortVersionString"] as? String ?? "?"
    let build = info?["CFBundleVersion"] as? String ?? "?"
    c.applicationNameForUserAgent = [c.applicationNameForUserAgent ?? "Mobile/15E148", "AgentBridge/\(version) (\(build))"].joined(separator: " ")
    let v = BridgeWebView(frame: .zero, configuration: c)
    v.uiDelegate = context.coordinator
    v.navigationDelegate = context.coordinator
    v.allowsBackForwardNavigationGestures = true
    v.scrollView.contentInsetAdjustmentBehavior = .never
    // Safari's web inspector only for a debug build from Xcode, not for TestFlight and App Store builds.
    #if DEBUG
    v.isInspectable = true
    #endif
    // Started by pressing a notification: its session opens instead of the list.
    v.load(URLRequest(url: Push.shared.pending ?? home))
    Push.shared.pending = nil
    Push.shared.web = v
    context.coordinator.web = v
    return v
  }

  func updateUIView(_ v: WKWebView, context: Context) {}

  final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler,
    ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    weak var web: WKWebView?

    // The page (web/apple-login.js) sends the nonce the server gave it; the system asks for the Apple ID, and the
    // identity token goes back to the page, which hands it to the server.
    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
      guard m.frameInfo.isMainFrame, m.frameInfo.securityOrigin.host == home.host, let body = m.body as? [String: Any] else { return }
      if m.name == "push", let action = body["action"] as? String, let id = body["id"] as? Int {
        return Push.shared.ask(action, id: id)
      }
      guard m.name == "appleSignIn", let nonce = body["nonce"] as? String else { return }
      let request = ASAuthorizationAppleIDProvider().createRequest()
      request.requestedScopes = [.fullName, .email]
      request.nonce = nonce
      let controller = ASAuthorizationController(authorizationRequests: [request])
      controller.delegate = self
      controller.presentationContextProvider = self
      controller.performRequests()
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
      web?.window ?? ASPresentationAnchor()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization a: ASAuthorization) {
      guard let cred = a.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = cred.identityToken, let token = String(data: tokenData, encoding: .utf8) else {
        return callPage("appleSignInFailed", "Apple 이 로그인 정보를 주지 않았어요. 다시 시도해 주세요.")
      }
      let code = cred.authorizationCode.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      // The name comes only at the first sign-in to this app.
      let name = cred.fullName.map { PersonNameComponentsFormatter.localizedString(from: $0, style: .default) } ?? ""
      callPage("appleSignInDone", ["token": token, "code": code, "name": name])
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
      // Closing the sheet is not an error to show.
      let canceled = (error as? ASAuthorizationError)?.code == .canceled
      callPage("appleSignInFailed", canceled ? "" : "Apple 로그인에 실패했어요. 다시 시도해 주세요.")
    }

    private func callPage(_ fn: String, _ arg: Any) {
      guard let data = try? JSONSerialization.data(withJSONObject: [arg], options: [.fragmentsAllowed]),
            let json = String(data: data, encoding: .utf8) else { return }
      web?.evaluateJavaScript("window.\(fn)?.(...\(json))")
    }

    // The page asked for the microphone: the app already holds the system's answer, so no second web prompt.
    func webView(_ v: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
      decisionHandler(origin.host == home.host ? .grant : .prompt)
    }

    func webView(_ v: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
      guard let url = a.request.url else { return decisionHandler(.allow) }
      let web = url.scheme == "https" || url.scheme == "http"
      if web, let host = url.host, inApp.contains(host) || a.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
      if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return decisionHandler(.allow) }
      UIApplication.shared.open(url)
      decisionHandler(.cancel)
    }

    // target=_blank: GitHub and the bridge open in place, the rest in Safari.
    func webView(_ v: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
      if let url = a.request.url {
        if let host = url.host, inApp.contains(host) { v.load(a.request) } else { UIApplication.shared.open(url) }
      }
      return nil
    }

    func webView(_ v: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
      present(UIAlertController(title: nil, message: m, preferredStyle: .alert), ok: completionHandler)
    }

    func webView(_ v: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
      let a = UIAlertController(title: nil, message: m, preferredStyle: .alert)
      a.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in completionHandler(false) })
      present(a, ok: { completionHandler(true) })
    }

    // The page went blank after the system dropped its process (memory): load it again.
    func webViewWebContentProcessDidTerminate(_ v: WKWebView) { v.reload() }

    private func present(_ a: UIAlertController, ok: @escaping () -> Void) {
      a.addAction(UIAlertAction(title: "확인", style: .default) { _ in ok() })
      let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene
      scene?.keyWindow?.rootViewController?.present(a, animated: true)
    }
  }
}

/// Receives the APNs device token and the presses on notifications (REQ-F-774).
final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(_ app: UIApplication, didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    // Set here, before launching ends, so a press that started the app is not missed.
    UNUserNotificationCenter.current().delegate = Push.shared
    Push.shared.refresh()
    return true
  }

  func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
    Push.shared.registered(token.map { String(format: "%02x", $0) }.joined())
  }

  func application(_ app: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    Push.shared.failed(error)
  }
}

/**
 * 앱 알림 (REQ-F-774). The page's switch asks `status` (the system's permission and the token, if any) or `enable`
 * (asks the person once, then registers with Apple); each answer goes back as window.bridgePush(id, {...}), and the
 * page hands the token to the server. Nothing is asked when the app opens: only when the switch is turned on.
 */
final class Push: NSObject, UNUserNotificationCenterDelegate {
  static let shared = Push()
  weak var web: WKWebView?
  /** A session to open once the web view exists (the app was started by a notification). */
  var pending: URL?
  /** `enable` asks waiting for the token from Apple. */
  private var waiting: [Int] = []
  private var token: String? {
    get { UserDefaults.standard.string(forKey: "apnsToken") }
    set { UserDefaults.standard.set(newValue, forKey: "apnsToken") }
  }

  // TestFlight and App Store builds (Release) use Apple's production APNs; a debug build from Xcode, its sandbox.
  #if DEBUG
  private let env = "sandbox"
  #else
  private let env = "production"
  #endif
  private var device: String { UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone" }

  /// Permission already given: register again, so a token Apple changed is the one kept.
  func refresh() {
    UNUserNotificationCenter.current().getNotificationSettings { s in
      guard s.authorizationStatus == .authorized else { return }
      DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
    }
  }

  func ask(_ action: String, id: Int) {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { s in
      DispatchQueue.main.async {
        guard action == "enable", s.authorizationStatus != .denied else { return self.reply(id, s.authorizationStatus) }
        // Asks the person only the first time; afterwards it answers at once with what they chose.
        center.requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
          DispatchQueue.main.async {
            guard ok else { return self.reply(id, .denied) }
            self.waiting.append(id)
            UIApplication.shared.registerForRemoteNotifications()
          }
        }
      }
    }
  }

  func registered(_ hex: String) {
    token = hex
    let ids = waiting
    waiting = []
    for id in ids { reply(id, .authorized) }
  }

  func failed(_ error: Error) {
    let ids = waiting
    waiting = []
    for id in ids { send(id, ["permission": "granted", "error": "Apple 에 이 기기를 등록하지 못했어요 (\(error.localizedDescription))"]) }
  }

  private func reply(_ id: Int, _ status: UNAuthorizationStatus) {
    let name: String = switch status {
    case .authorized: "granted"
    case .denied: "denied"
    case .provisional: "provisional"
    case .ephemeral: "ephemeral"
    default: "notDetermined"
    }
    var m: [String: Any] = ["permission": name, "env": env, "device": device]
    if status == .authorized, let token { m["token"] = token }
    send(id, m)
  }

  private func send(_ id: Int, _ m: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: m), let json = String(data: data, encoding: .utf8) else { return }
    web?.evaluateJavaScript("window.bridgePush?.(\(id), \(json))")
  }

  private func url(_ n: UNNotification) -> URL? {
    guard let sid = n.request.content.userInfo["sid"] as? String, !sid.isEmpty,
          sid.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { return nil }
    return home.appendingPathComponent("s").appendingPathComponent(sid)
  }

  // In front: shown as a banner, except for the session already on screen (the page shows it there).
  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                              withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    if let u = url(n), web?.url?.path == u.path { return done([]) }
    done([.banner, .list, .sound])
  }

  // Pressed: that session opens.
  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
                              withCompletionHandler done: @escaping () -> Void) {
    defer { done() }
    guard let u = url(r.notification) else { return }
    if let web { web.load(URLRequest(url: u)) } else { pending = u }
  }
}

/// Drops the ^ v 완료 bar Safari puts over the keyboard: the page has its own send and close, and the bar only
/// takes a line of the screen. The view that edits text asks the web view for its inputAccessoryView, so overriding
/// it here is enough (public since iOS 13, WebKit 47455a2a21).
final class BridgeWebView: WKWebView {
  override var inputAccessoryView: UIView? { nil }
}
