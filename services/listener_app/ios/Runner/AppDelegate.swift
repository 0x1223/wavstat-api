import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private static let linkChannelName = "com.kingzbreadent.kingzlisten/link"
  private static var linkChannel: FlutterMethodChannel?
  private static var pendingURL: String?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    if let url = launchOptions?[.url] as? URL {
      Self.pendingURL = url.absoluteString
    }

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    let channel = FlutterMethodChannel(
      name: Self.linkChannelName,
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    Self.linkChannel = channel
    channel.setMethodCallHandler { call, result in
      if call.method == "initialUrl" {
        result(Self.pendingURL)
        Self.pendingURL = nil
      } else {
        result(FlutterMethodNotImplemented)
      }
    }
  }

  override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey : Any] = [:]
  ) -> Bool {
    Self.deliver(url)
    return true
  }

  static func deliver(_ url: URL) {
    let value = url.absoluteString
    if let channel = linkChannel {
      channel.invokeMethod("openUrl", arguments: value)
    } else {
      pendingURL = value
    }
  }
}
