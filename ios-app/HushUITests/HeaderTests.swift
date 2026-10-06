import XCTest

/// Headers while scrolling, against the live demo: titles stay readable and
/// in place, pinned filters stay in reach, and the filters a screen scrolled
/// away are still a tap away on its title. Run on iOS 18 and iOS 26: their
/// bars differ.
@MainActor
final class HeaderTests: XCTestCase {
    private var app: XCUIApplication!

    /// The demo, its overview loaded. Not setUp: that runs off the main actor.
    private func launch() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launch()
        app.buttons["Try the demo"].tap()
        XCTAssertTrue(card("Stillwater").waitForExistence(timeout: 15))
    }

    private func card(_ title: String) -> XCUIElement {
        app.buttons.containing(.staticText, identifier: title).firstMatch
    }

    /// The title, which a title menu turns into a button.
    private func title(_ text: String) -> XCUIElement {
        let bar = app.navigationBars.firstMatch
        let button = bar.buttons[text]
        return button.exists ? button : bar.staticTexts[text]
    }

    private func scrollFar() {
        for _ in 0..<3 { app.swipeUp() }
    }

    func testTheOverviewsFiltersStayInReach() {
        launch()
        scrollFar()
        XCTAssertTrue(app.buttons["Period, Last 30 days"].isHittable, "the overview's chips are pinned")
        XCTAssertTrue(title("Demo").isHittable)
    }

    func testTheServersNameSwitchesServers() {
        launch()
        title("Demo").tap()
        let servers = app.buttons["Servers…"]
        XCTAssertTrue(servers.waitForExistence(timeout: 5), "the title opens the servers")
        XCTAssertTrue(app.buttons["Demo"].exists)
        servers.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    }

    func testAnAppsFiltersFromItsTitle() {
        launch()
        card("Stillwater").tap()
        XCTAssertTrue(app.staticTexts["Active installs"].waitForExistence(timeout: 15))
        let chip = app.buttons["Period, Last 30 days"]
        XCTAssertTrue(chip.isHittable)
        scrollFar()
        XCTAssertFalse(chip.exists && chip.isHittable, "the app page's chips scroll away with it")
        XCTAssertTrue(title("Stillwater").isHittable, "the title stays")

        title("Stillwater").tap()
        // The menu's item and the chip scrolled off screen share a label.
        let item = app.buttons.matching(identifier: "Period, Last 30 days").allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(item, "the title opens the filters")
        item?.tap()
        app.buttons["Last 90 days"].tap()
        if #available(iOS 26, *) {
            XCTAssertTrue(app.navigationBars.staticTexts["Last 90 days"].waitForExistence(timeout: 5), "the subtitle says the period")
        }
        app.swipeDown(velocity: .fast)
        app.swipeDown(velocity: .fast)
        app.swipeDown(velocity: .fast)
        XCTAssertTrue(app.buttons["Period, Last 90 days"].waitForExistence(timeout: 5), "the chips follow the title's menu")

        title("Stillwater").tap()
        app.buttons["Reset Filters"].tap()
        XCTAssertTrue(app.buttons["Period, Last 30 days"].waitForExistence(timeout: 5))
    }

    func testEveryAppScreenKeepsItsTitle() {
        launch()
        card("Stillwater").tap()
        XCTAssertTrue(app.staticTexts["Active installs"].waitForExistence(timeout: 15))
        for name in ["Funnels", "Retention", "Engagement", "Audience", "Events"] {
            let c = card(name)
            for _ in 0..<5 where !c.isHittable { app.swipeUp() }
            c.tap()
            XCTAssertTrue(title(name).waitForExistence(timeout: 10), "\(name) has its title")
            scrollFar()
            XCTAssertTrue(title(name).isHittable, "\(name) keeps its title while scrolled")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            for _ in 0..<3 { app.swipeDown(velocity: .fast) }
        }
    }

    func testTheFeedbackStatusStaysInReach() {
        launch()
        let tab = app.tabBars.buttons["Feedback"]
        (tab.exists ? tab : app.buttons["Feedback"].firstMatch).tap()
        let picker = app.segmentedControls.firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 10))
        app.cells.firstMatch.swipeUp()
        XCTAssertTrue(picker.isHittable, "the status picker is pinned")
        XCTAssertTrue(title("Feedback").isHittable)
    }
}
