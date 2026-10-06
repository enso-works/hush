import XCTest

/// Every screen's header at rest, part way scrolled and well scrolled, for
/// checking by eye: SCREENSHOTS_DIR (TEST_RUNNER_SCREENSHOTS_DIR) set,
/// against the live demo. iOS 18 and iOS 26 draw bars differently: run it on both.
@MainActor
final class ScrollShots: XCTestCase {
    private var app: XCUIApplication!
    private var dir = ""

    private func save(_ name: String) {
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(component: "\(name).png"))
    }

    /// A drag held to the end, so the frame is mid-scroll, not after it settles.
    private func drag(_ dy: CGFloat) {
        let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -dy)), withVelocity: .slow, thenHoldForDuration: 0.3)
    }

    /// Three frames of a screen: at rest, a little scrolled, well scrolled; then back to the top.
    private func frames(_ name: String) {
        sleep(1)
        save("\(name)-0")
        drag(80)
        save("\(name)-1")
        drag(400)
        save("\(name)-2")
        app.swipeDown(velocity: .fast)
        app.swipeDown(velocity: .fast)
    }

    private func card(_ title: String) -> XCUIElement {
        app.buttons.containing(.staticText, identifier: title).firstMatch
    }

    private func back() { app.navigationBars.buttons.element(boundBy: 0).tap() }

    private func tab(_ name: String) {
        let t = app.tabBars.buttons[name]
        (t.exists ? t : app.buttons[name].firstMatch).tap()
    }

    func testEveryHeader() throws {
        guard let d = ProcessInfo.processInfo.environment["SCREENSHOTS_DIR"] else { throw XCTSkip("SCREENSHOTS_DIR not set") }
        dir = d
        app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launch()
        app.buttons["Try the demo"].tap()

        XCTAssertTrue(card("Stillwater").waitForExistence(timeout: 15))
        frames("01-overview")
        card("Stillwater").tap()
        XCTAssertTrue(app.staticTexts["Active installs"].waitForExistence(timeout: 15))
        frames("02-app")
        for (i, title) in ["Funnels", "Retention", "Engagement", "Audience", "Events", "Remote config"].enumerated() {
            let c = card(title)
            for _ in 0..<5 where !c.isHittable { app.swipeUp() }
            c.tap()
            frames(String(format: "%02d-", i + 3) + title.lowercased().replacingOccurrences(of: " ", with: "-"))
            if title == "Events" {
                app.buttons["Screen viewed"].tap()
                frames("08b-event")
                back()
            }
            if title == "Remote config" {
                app.buttons.containing(.staticText, identifier: "paywall_variant").firstMatch.tap()
                frames("09-config-key")
                back()
            }
            back()
            app.swipeDown(velocity: .fast)
            app.swipeDown(velocity: .fast)
        }
        tab("Feedback")
        frames("10-inbox")
        app.cells.firstMatch.tap()
        frames("11-thread")
        tab("Settings")
        frames("12-settings")
        app.buttons.containing(.staticText, identifier: "Phones").firstMatch.tap()
        frames("13-phones")
    }
}
