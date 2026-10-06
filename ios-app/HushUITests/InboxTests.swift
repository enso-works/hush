import XCTest

/// The Feedback tab against a real, writable server: PAIR_LINK
/// (TEST_RUNNER_PAIR_LINK on the xcodebuild line) from its /admin/pairing,
/// on a server with open tickets, one of them "GPS drift in the city" from
/// an email. Skipped without one. It answers and closes that ticket.
@MainActor
final class InboxTests: XCTestCase {
    private func snap(_ app: XCUIApplication, _ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOTS_DIR"] else { return }
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(component: "\(name).png"))
    }

    func testAnsweringFeedback() throws {
        guard let raw = ProcessInfo.processInfo.environment["PAIR_LINK"], let url = URL(string: raw) else { throw XCTSkip("PAIR_LINK not set") }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launch()
        app.open(url)
        XCTAssertTrue(app.buttons["Connect"].waitForExistence(timeout: 10))
        app.buttons["Connect"].tap()
        XCTAssertTrue(app.staticTexts["Open feedback"].waitForExistence(timeout: 15))

        // A tab bar at the bottom on an iPhone, tabs at the top on an iPad.
        let tab = app.tabBars.buttons["Feedback"]
        (tab.exists ? tab : app.buttons["Feedback"].firstMatch).tap()
        // In the list: on an iPad the open thread shows the same subject beside it.
        let row = app.cells.containing(.staticText, identifier: "GPS drift in the city").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        snap(app, "inbox-open")

        row.tap()
        XCTAssertTrue(app.staticTexts["Between tall buildings my runs come out 10% too long."].waitForExistence(timeout: 10))
        snap(app, "thread")
        // A field that grows to several lines is a text view to the tests.
        let field = app.descendants(matching: .any).matching(identifier: "reply").firstMatch
        field.tap()
        field.typeText("Thanks Jo. Version 2.5 smooths the track between buildings.")
        snap(app, "thread-typing")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts["Thanks Jo. Version 2.5 smooths the track between buildings."].waitForExistence(timeout: 10))
        snap(app, "thread-answered")

        // On an iPhone the list is one step back; on an iPad it is beside the thread.
        let back = app.navigationBars.buttons["Feedback"]
        if back.exists { back.tap() }
        // Answered, so no longer among the open ones.
        XCTAssertTrue(row.waitForNonExistence(timeout: 5))
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Answered")).element(boundBy: 0).tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        snap(app, "inbox-answered")

        // Swipe to close.
        row.swipeRight()
        app.buttons["Close"].firstMatch.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 5))

        app.buttons["All"].tap()
        let search = app.searchFields.firstMatch
        if !search.exists { app.swipeDown() }
        search.tap()
        search.typeText("widget")
        XCTAssertTrue(app.cells.containing(.staticText, identifier: "Widget shows yesterday").firstMatch.waitForExistence(timeout: 10))
        snap(app, "inbox-search")
    }
}
