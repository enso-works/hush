import XCTest

/// Not a test of behaviour: frames of the arrival, for looking at by hand.
/// Runs only with SCREENSHOTS_DIR set.
@MainActor
final class MotionShots: XCTestCase {
    func testArrivalFrames() throws {
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOTS_DIR"] else { throw XCTSkip("SCREENSHOTS_DIR not set") }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launch()
        app.buttons["Try the demo"].tap()
        // Frames until the answer has been in for a few, so the cross-fade is among them.
        var after = 0
        for i in 0..<60 where after < 4 {
            try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(component: "arrival-\(String(format: "%02d", i)).png"))
            if app.staticTexts["Pace"].exists { after += 1 }
        }
    }

    /// The Overview and an app's page at the largest accessibility text size.
    func testLargeText() throws {
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOTS_DIR"] else { throw XCTSkip("SCREENSHOTS_DIR not set") }
        let save = { (name: String) in
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(component: "\(name).png"))
        }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"]
        app.launch()
        app.buttons["Try the demo"].tap()
        // The cards are lazy: at this size they are made as they scroll in.
        XCTAssertTrue(app.staticTexts["Open feedback"].waitForExistence(timeout: 15))
        save("large-overview")
        app.swipeUp()
        app.swipeUp()
        save("large-overview-cards")
        let card = app.staticTexts["Stillwater"].firstMatch
        for _ in 0..<4 where !card.isHittable { app.swipeUp() }
        card.tap()
        XCTAssertTrue(app.staticTexts["Activity"].waitForExistence(timeout: 15))
        save("large-app")
        app.swipeUp()
        app.swipeUp()
        save("large-app-retention")
        app.swipeUp()
        save("large-app-bars")
    }
}
