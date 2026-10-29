import XCTest

/// A website beside the apps, and the Campaigns and Attribution screens. The
/// demo has no website yet: HUSH_WEBSITE_URL (TEST_RUNNER_HUSH_WEBSITE_URL on
/// the xcodebuild line) names a server whose catalog has `stillwater-site`
/// (`"kind": "website", "promotes": ["stillwater"]`) with visits in it, read
/// without a token (a DEMO=1 server, or a proxy that adds it).
@MainActor
final class WebsiteTests: XCTestCase {
    private var app: XCUIApplication!

    private func launch() throws {
        guard let url = ProcessInfo.processInfo.environment["HUSH_WEBSITE_URL"] else { throw XCTSkip("HUSH_WEBSITE_URL not set") }
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-demo-url", url]
        app.launch()
        app.buttons["Try the demo"].tap()
        XCTAssertTrue(card("Stillwater site").waitForExistence(timeout: 15))
    }

    private func card(_ title: String) -> XCUIElement {
        app.buttons.containing(.staticText, identifier: title).firstMatch
    }

    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    private func snap(_ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOTS_DIR"] else { return }
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(component: "\(name).png"))
    }

    private func open(_ title: String) {
        let c = card(title)
        for _ in 0..<4 where !c.isHittable { app.swipeUp() }
        c.tap()
    }

    func testAWebsitesScreens() throws {
        try launch()
        snap("website-overview")
        card("Stillwater site").tap()
        XCTAssertTrue(app.staticTexts["Visitors"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Website for stillwater"].exists)
        XCTAssertFalse(app.staticTexts["Active installs"].exists)
        snap("website")
        app.swipeUp()
        XCTAssertFalse(card("Attribution").exists, "a website has no App Store attribution")
        snap("website-cards")

        open("Pages")
        XCTAssertTrue(app.staticTexts["Top pages"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["/features"].waitForExistence(timeout: 15))
        snap("website-pages")
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["Store clicks"].waitForExistence(timeout: 5))
        snap("website-pages-2")
        back()

        open("Campaigns")
        XCTAssertTrue(app.staticTexts["autumn launch"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Store clicked"].exists)
        snap("website-campaigns")
        app.buttons["Split by, Campaign"].tap()
        app.buttons["Referrer"].tap()
        XCTAssertTrue(app.staticTexts["google.com"].waitForExistence(timeout: 15))
        snap("website-referrers")
    }

    func testAnAppsCampaignsAndAttribution() throws {
        try launch()
        card("Stillwater").tap()
        XCTAssertTrue(app.staticTexts["Active installs"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Sold on stillwater-site"].exists)

        open("Campaigns")
        XCTAssertTrue(app.staticTexts["autumn update"].waitForExistence(timeout: 15))
        snap("app-campaigns")
        back()

        open("Attribution")
        XCTAssertTrue(app.staticTexts["Ad campaigns"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["How far they got"].exists)
        snap("app-attribution")
        app.buttons["App Store"].tap()
        XCTAssertTrue(app.staticTexts["meta_autumn"].waitForExistence(timeout: 10))
        snap("app-attribution-store")
        app.buttons["Values"].tap()
        XCTAssertTrue(app.staticTexts["Conversion values"].waitForExistence(timeout: 10))
        snap("app-attribution-values")
    }
}
