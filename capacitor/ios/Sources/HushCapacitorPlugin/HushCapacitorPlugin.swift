import Capacitor
import StoreKit
import UIKit
#if canImport(AdAttributionKit)
import AdAttributionKit
#endif

// What @bavrk/hush cannot do from a web view on iOS:
//   - Apple's ad attribution: the conversion value, for SKAdNetwork and
//     AdAttributionKit alike (Apple asks apps that use both to call both).
//   - Where the build came from: TestFlight, the App Store, a development or
//     ad hoc build, the simulator.
//   - Background runway for the flush when the app leaves the foreground.
// The same as @bavrk/hush-expo's module, down to iOS 15.
@objc(HushCapacitorPlugin)
public class HushCapacitorPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HushCapacitorPlugin"
    public let jsName = "HushCapacitor"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "distribution", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateConversionValue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginBackgroundTask", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endBackgroundTask", returnType: CAPPluginReturnPromise)
    ]

    // Only touched on the main queue (Capacitor calls plugin methods on its
    // own queue, so they hop there; iOS calls expiration handlers there), so
    // no lock.
    private var tasks: [Int: UIBackgroundTaskIdentifier] = [:]
    private var nextTask = 0

    @objc func distribution(_ call: CAPPluginCall) {
        call.resolve(["value": Self.distribution()])
    }

    // fine 0-63, coarse "low" | "medium" | "high", lock ends the window.
    @objc func updateConversionValue(_ call: CAPPluginCall) {
        let fine = call.getInt("fine") ?? 0
        let coarse = call.getString("coarse") ?? "low"
        let lock = call.getBool("lock") ?? false
        Task {
            do {
                try await Self.updateConversionValue(fine: fine, coarse: coarse, lockWindow: lock)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    // An opaque id, or -1 when the OS refused (already out of background time).
    @objc func beginBackgroundTask(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let id = self.nextTask
            self.nextTask += 1
            let task = UIApplication.shared.beginBackgroundTask(withName: "hush-flush") { [weak self] in
                self?.endTask(id)
            }
            if task == .invalid {
                call.resolve(["id": -1])
                return
            }
            self.tasks[id] = task
            call.resolve(["id": id])
        }
    }

    @objc func endBackgroundTask(_ call: CAPPluginCall) {
        let id = call.getInt("id") ?? -1
        DispatchQueue.main.async {
            self.endTask(id)
            call.resolve()
        }
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

    /// Both frameworks, each on its own: one refusing (SKAdNetwork on the
    /// simulator, AdAttributionKit before iOS 17.4) does not stop the other.
    /// Throws only when neither took the value.
    static func updateConversionValue(fine: Int, coarse: String, lockWindow: Bool) async throws {
        let value = max(0, min(63, fine))
        var failure: Error?
        var accepted = false
        do {
            try await updateSKAdNetwork(value, coarse: coarse, lockWindow: lockWindow)
            accepted = true
        } catch {
            failure = error
        }
        #if canImport(AdAttributionKit)
        if #available(iOS 17.4, *) {
            do {
                let c: AdAttributionKit.CoarseConversionValue = coarse == "high" ? .high : coarse == "medium" ? .medium : .low
                try await Postback.updateConversionValue(value, coarseConversionValue: c, lockPostback: lockWindow)
                accepted = true
            } catch {
                failure = failure ?? error
            }
        }
        #endif
        if !accepted, let failure { throw failure }
    }

    /// SKAdNetwork 4 from iOS 16.1 takes all three. 15.4 to 16.0 (SKAdNetwork 3)
    /// has no coarse value and no lock, so only the fine value goes. Before
    /// 15.4 the only call is updateConversionValue: deprecated in 15.4 but not
    /// removed, it compiles without a warning against a 15.0 target and
    /// reports no error, so it counts as taken.
    private static func updateSKAdNetwork(_ value: Int, coarse: String, lockWindow: Bool) async throws {
        if #available(iOS 16.1, *) {
            let c: SKAdNetwork.CoarseConversionValue = coarse == "high" ? .high : coarse == "medium" ? .medium : .low
            try await SKAdNetwork.updatePostbackConversionValue(value, coarseValue: c, lockWindow: lockWindow)
        } else if #available(iOS 15.4, *) {
            try await SKAdNetwork.updatePostbackConversionValue(value)
        } else {
            SKAdNetwork.updateConversionValue(value)
        }
    }
}

