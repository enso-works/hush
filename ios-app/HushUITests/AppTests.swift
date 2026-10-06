import XCTest

/// An app's page and every screen under it, against the live demo: needs the network.
@MainActor
final class AppTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launch()
        app.buttons["Try the demo"].tap()
    }

    /// With SCREENSHOTS_DIR set (TEST_RUNNER_SCREENSHOTS_DIR on the xcodebuild line), saves what the screen shows there.
    private func snap(_ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOTS_DIR"] else { return }
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(component: "\(name).png"))
    }

    private func card(_ title: String) -> XCUIElement {
        app.buttons.containing(.staticText, identifier: title).firstMatch
    }

    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    private func openStillwater() {
        let card = card("Stillwater")
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        card.tap()
        XCTAssertTrue(app.staticTexts["Active installs"].waitForExistence(timeout: 15))
    }

    func testTheOverviewsOrder() {
        XCTAssertTrue(card("Stillwater").waitForExistence(timeout: 15))
        app.buttons["Order, Most active"].tap()
        app.buttons["Name"].tap()
        XCTAssertTrue(app.buttons["Order, Name"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Reset"].exists)
        snap("overview-by-name")
        app.buttons["Reset"].tap()
        XCTAssertTrue(app.buttons["Order, Most active"].waitForExistence(timeout: 5))
    }

    func testAnAppsScreens() {
        openStillwater()
        XCTAssertTrue(app.buttons["Period, Last 30 days"].exists)
        snap("app")
        app.swipeUp()
        snap("app-cards")

        for (title, check, shot) in [
            ("Funnels", "Build a funnel", "app-funnels"),
            ("Retention", "Cohorts", "app-retention"),
            ("Engagement", "How sessions start", "app-engagement"),
            ("Audience", "Versions", "app-audience"),
        ] {
            let c = card(title)
            if !c.isHittable { app.swipeUp() }
            c.tap()
            XCTAssertTrue(app.staticTexts[check].waitForExistence(timeout: 15), "\(title) shows \(check)")
            sleep(1)
            snap(shot)
            back()
        }

        card("Events").tap()
        XCTAssertTrue(app.navigationBars["Events"].waitForExistence(timeout: 10))
        let first = app.buttons["Screen viewed"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        snap("app-events")
        first.tap()
        XCTAssertTrue(app.staticTexts["By prop"].waitForExistence(timeout: 10))
        sleep(2)
        snap("app-event")
        back()
        back()

        // A filter changed on the page shows as such, and resets.
        app.swipeDown()
        app.buttons["Period, Last 30 days"].tap()
        app.buttons["Last 90 days"].tap()
        XCTAssertTrue(app.buttons["Period, Last 90 days"].waitForExistence(timeout: 5))
        sleep(2)
        snap("app-90-days")
        app.buttons["Reset"].tap()
        XCTAssertTrue(app.buttons["Period, Last 30 days"].waitForExistence(timeout: 5))
    }

    func testFeedbackFromAnApp() {
        openStillwater()
        app.swipeUp()
        let c = card("Feedback")
        if !c.isHittable { app.swipeUp() }
        c.tap()
        XCTAssertTrue(app.navigationBars["Feedback"].waitForExistence(timeout: 10))
        snap("app-feedback")
    }

    func testLookingUpAnInstall() {
        XCTAssertTrue(card("Stillwater").waitForExistence(timeout: 15))
        app.navigationBars.buttons["More"].tap()
        app.buttons["Look Up an Install"].tap()
        let field = app.textFields["install-id"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("00000000-0000-4000-8000-000000000000\n")
        XCTAssertTrue(app.staticTexts["Nothing for this id"].waitForExistence(timeout: 10))
        snap("install-none")
        // A real one, when INSTALL_ID names one of the demo's (from its tickets).
        if let id = ProcessInfo.processInfo.environment["INSTALL_ID"] {
            app.buttons["Clear"].tap()
            field.typeText(id + "\n")
            XCTAssertTrue(app.staticTexts["First seen"].waitForExistence(timeout: 10))
            snap("install")
            app.swipeUp()
            snap("install-events")
        }
    }
}
