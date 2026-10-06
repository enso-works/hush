import XCTest

/// Frames of each screen's header while it scrolls, for checking by eye:
/// SCREENSHOTS_DIR (TEST_RUNNER_SCREENSHOTS_DIR) set, against the live demo.
@MainActor
final class ScrollShots: XCTestCase {
    func testHeadersWhileScrolling() throws {
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOTS_DIR"] else { throw XCTSkip("SCREENSHOTS_DIR not set") }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launch()
        app.buttons["Try the demo"].tap()
        let save = { (name: String) in
            try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(component: "\(name).png"))
        }
        // A short drag, held: the frame mid-scroll, not after it settles.
        let drag = { (dy: CGFloat) in
            let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -dy)))
        }
        XCTAssertTrue(app.buttons.containing(.staticText, identifier: "Stillwater").firstMatch.waitForExistence(timeout: 15))
        sleep(1)
        save("scroll-overview-0")
        drag(60); save("scroll-overview-1")
        drag(200); save("scroll-overview-2")
        app.swipeDown(); app.swipeDown()
        app.buttons.containing(.staticText, identifier: "Stillwater").firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Active installs"].waitForExistence(timeout: 15))
        sleep(1)
        save("scroll-app-0")
        drag(60); save("scroll-app-1")
        drag(250); save("scroll-app-2")
        drag(500); save("scroll-app-3")
        let tab = app.tabBars.buttons["Feedback"]
        (tab.exists ? tab : app.buttons["Feedback"].firstMatch).tap()
        sleep(3)
        save("scroll-inbox-0")
        drag(150); save("scroll-inbox-1")
        app.cells.firstMatch.tap()
        sleep(3)
        save("scroll-thread-0")
    }
}
