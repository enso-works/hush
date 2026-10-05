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
}
