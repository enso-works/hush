import ExpoModulesCore
import StoreKit
import UIKit
#if canImport(AdAttributionKit)
import AdAttributionKit
#endif

// What @bavrk/hush cannot do from JavaScript on iOS:
//   - Apple's ad attribution: the conversion value, for SKAdNetwork and
//     AdAttributionKit alike (Apple asks apps that use both to call both).
//   - Where the build came from: TestFlight, the App Store, a development or
//     ad hoc build, the simulator.
//   - Background runway for the flush when the app leaves the foreground.
public class HushExpoModule: Module {
  // Only touched on the main queue (the functions below run there, and iOS
  // calls expiration handlers there), so no lock.
  private var tasks: [Int: UIBackgroundTaskIdentifier] = [:]
  private var nextTask = 0

  public func definition() -> ModuleDefinition {
    Name("HushExpo")

    Constant("distribution") { Self.distribution() }

    // fine 0-63, coarse "low" | "medium" | "high", lock ends the window.
    AsyncFunction("updateConversionValue") { (fine: Int, coarse: String, lockWindow: Bool) in
      try await Self.updateConversionValue(fine: fine, coarse: coarse, lockWindow: lockWindow)
    }

    // An opaque id, or -1 when the OS refused (already out of background time).
    AsyncFunction("beginBackgroundTask") { () -> Int in
      let id = self.nextTask
      self.nextTask += 1
      let task = UIApplication.shared.beginBackgroundTask(withName: "hush-flush") { [weak self] in
        self?.endTask(id)
      }
      if task == .invalid { return -1 }
      self.tasks[id] = task
      return id
    }.runOnQueue(.main)

    AsyncFunction("endBackgroundTask") { (id: Int) in
      self.endTask(id)
    }.runOnQueue(.main)
  }

  private func endTask(_ id: Int) {
    guard let task = tasks.removeValue(forKey: id), task != .invalid else { return }
    UIApplication.shared.endBackgroundTask(task)
  }

  /// A development or ad hoc build carries its provisioning profile; TestFlight's receipt is a sandbox one.
  static func distribution() -> String {
    #if targetEnvironment(simulator)
    return "simulator"
    #else
    if Bundle.main.path(forResource: "embedded", ofType: "mobileprovision") != nil { return "development" }
    if Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" { return "testflight" }
    return "app_store"
    #endif
  }

  static func updateConversionValue(fine: Int, coarse: String, lockWindow: Bool) async throws {
    let value = max(0, min(63, fine))
    let skanCoarse: SKAdNetwork.CoarseConversionValue = coarse == "high" ? .high : coarse == "medium" ? .medium : .low
    try await SKAdNetwork.updatePostbackConversionValue(value, coarseValue: skanCoarse, lockWindow: lockWindow)
    #if canImport(AdAttributionKit)
    if #available(iOS 17.4, *) {
      let c: AdAttributionKit.CoarseConversionValue = coarse == "high" ? .high : coarse == "medium" ? .medium : .low
      try await Postback.updateConversionValue(value, coarseConversionValue: c, lockPostback: lockWindow)
    }
    #endif
  }
}
