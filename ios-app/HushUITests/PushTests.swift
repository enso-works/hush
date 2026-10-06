import XCTest

/// Notifications against a real, writable server: PAIR_LINK
/// (TEST_RUNNER_PAIR_LINK). Turns them on, then waits for pushes sent from
/// outside with `simctl push` (see ios-app/README.md): taps the first
/// to open its thread, and answers the second from the notification. Skipped
/// without a link.
@MainActor
final class PushTests: XCTestCase {
    private var app: XCUIApplication!
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    private func snap(_ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOTS_DIR"] else { return }
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(component: "\(name).png"))
    }

    private func tab(_ name: String) {
        let t = app.tabBars.buttons[name]
        (t.exists ? t : app.buttons[name].firstMatch).tap()
    }

    /// A notification on screen, by its title: a banner, or the lock screen's list.
    private func notification(_ title: String, timeout: TimeInterval) -> XCUIElement? {
        let match = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        return match.waitForExistence(timeout: timeout) ? match : nil
    }

    func testNotifications() throws {
        guard let raw = ProcessInfo.processInfo.environment["PAIR_LINK"], let url = URL(string: raw) else { throw XCTSkip("PAIR_LINK not set") }
        continueAfterFailure = false
        app = XCUIApplication()
        // A stand-in APNs token: the pushes come from simctl, not Apple.
        app.launchArguments = ["-ui-testing", "-push-token", String(repeating: "ab", count: 32)]
        app.launch()
        app.open(url)
        XCTAssertTrue(app.buttons["Connect"].waitForExistence(timeout: 10))
        app.buttons["Connect"].tap()
        XCTAssertTrue(app.staticTexts["Open feedback"].waitForExistence(timeout: 15))

        tab("Settings")
        app.buttons.containing(.staticText, identifier: "Notifications").firstMatch.tap()
        let toggle = app.switches["Notify This Phone"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        // The switch itself, at the row's trailing end: a tap on the label does nothing on iOS 26.
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }
        let signedUp = app.staticTexts["New feedback"].waitForExistence(timeout: 15)
        if !signedUp { snap("push-not-signed-up") }
        XCTAssertTrue(signedUp, "signed up: the choices show")
        snap("push-settings")

        // The script sees the sign-up on the server and sends a new ticket's push.
        let first = try XCTUnwrap(notification("New idea in Pace", timeout: 90), "the first push arrives")
        snap("push-banner")
        first.tap()
        XCTAssertTrue(app.staticTexts["Apple Watch app"].waitForExistence(timeout: 10), "tapping it opens the thread")
        snap("push-opened")

        // Then a user's reply, answered from the notification itself.
        XCUIDevice.shared.press(.home)
        let second = try XCTUnwrap(notification("Reply in Pace", timeout: 90), "the second push arrives")
        second.press(forDuration: 1.2)
        let reply = springboard.buttons["Reply"]
        XCTAssertTrue(reply.waitForExistence(timeout: 5), "the notification offers Reply")
        snap("push-actions")
        reply.tap()
        springboard.typeText("Answered from the lock screen.")
        snap("push-typing")
        let send = springboard.buttons["Send"]
        if send.exists { send.tap() } else { springboard.typeText("\n") }
        sleep(4)
    }
}
