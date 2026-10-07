import XCTest

/// Apps with no events for 30 days, against the demo's Driftwood: under the
/// others whatever the order, flagged, and still a tap away. HUSH_DEMO_URL
/// (TEST_RUNNER_HUSH_DEMO_URL on the xcodebuild line) runs it against a local
/// DEMO=1 server instead of the live demo.
@MainActor
final class InactiveTests: XCTestCase {
    private var app: XCUIApplication!

    private func launch() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        if let url = ProcessInfo.processInfo.environment["HUSH_DEMO_URL"] { app.launchArguments += ["-demo-url", url] }
        app.launch()
        app.buttons["Try the demo"].tap()
        XCTAssertTrue(card("Stillwater").waitForExistence(timeout: 15))
    }

    private func card(_ title: String) -> XCUIElement {
        app.buttons.containing(.staticText, identifier: title).firstMatch
    }

    private func snap(_ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOTS_DIR"] else { return }
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(component: "\(name).png"))
    }

    private func scrollTo(_ element: XCUIElement) {
        for _ in 0..<6 where !element.isHittable { app.swipeUp() }
    }

    func testAnInactiveAppGoesLastWhateverTheOrder() {
        launch()
        let header = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Inactive'")).firstMatch
        let driftwood = card("Driftwood")
        scrollTo(driftwood)
        XCTAssertTrue(header.exists, "a section of its own")
        XCTAssertGreaterThan(driftwood.frame.minY, card("Tally").frame.minY)
        XCTAssertTrue(driftwood.staticTexts["Inactive"].exists, "flagged")
        snap("overview-inactive")

        // Name order would put Driftwood first; it stays last.
        for _ in 0..<6 { app.swipeDown(velocity: .fast) }
        app.buttons["Order, Most active"].tap()
        app.buttons["Name"].tap()
        XCTAssertTrue(app.buttons["Order, Name"].waitForExistence(timeout: 5))
        scrollTo(driftwood)
        XCTAssertGreaterThan(driftwood.frame.minY, card("Tally").frame.minY)

        driftwood.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Inactive for'")).firstMatch.waitForExistence(timeout: 30),
                      "its page says so")
        snap("app-inactive")
    }
}
