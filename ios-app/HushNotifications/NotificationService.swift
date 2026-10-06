import HushKit
@preconcurrency import UserNotifications

/// A push through the relay arrives with a placeholder ("Something new on
/// one of your servers") and the real words sealed with the key this phone
/// gave that server. This opens it with the key from the shared keychain and
/// shows what it says. One that does not open shows the placeholder.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            return contentHandler(request.content)
        }
        let keys = PushKeys(accessGroup: Bundle.main.object(forInfoDictionaryKey: "HushKeychainGroup") as? String)
        if let revealed = PushSeal.reveal(request.content.userInfo, keyFor: keys.key(for:)) {
            if let title = revealed.title { content.title = title }
            content.subtitle = revealed.subtitle ?? ""
            if let body = revealed.body { content.body = body }
            // The app reads the ticket from here when it is tapped or answered.
            var info = request.content.userInfo
            info["sealed"] = nil
            for (k, v) in revealed.userInfo { info[k] = v }
            content.userInfo = info
        }
        contentHandler(content)
    }
}
