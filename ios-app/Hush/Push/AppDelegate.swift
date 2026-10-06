import HushKit
import SwiftUI
import UserNotifications

/// The app's model, and what only a delegate hears: the APNs token, and a
/// notification tapped or answered from the lock screen.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let model = AppModel(store: HushApp.store())
    let push = PushCenter()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([PushCenter.ticketCategory])
        push.model = model
        model.willRemove = { [push] server, client in push.forget(server, client: client) }
        push.launched()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        push.tokenArrived(deviceToken.hexToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        push.tokenFailed(error)
    }

    // In the app already: show it anyway, and the inbox reads the new one.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        await MainActor.run { Task { await self.model.inbox?.load() } }
        return [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let ticket = PushTicket(info) else { return }
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        await push.handle(ticket, action: action, text: text)
    }
}
