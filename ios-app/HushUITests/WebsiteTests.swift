import XCTest

/// A website apart from the apps: its own section on the overview, its own
/// page (visitors, sources, landing pages, devices, its goal), and on the app
/// it sells, a Websites card. The demo's `stillwater-site` sells Stillwater;
/// `stillwater-shop` is a shop, with orders and revenue.
/// HUSH_DEMO_URL (TEST_RUNNER_HUSH_DEMO_URL on the xcodebuild line) points at
/// a local DEMO=1 server in place of the live demo.
@MainActor
final class WebsiteTests: XCTestCase {
    private var app: XCUIApplication!

    private func launch() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        if let url = ProcessInfo.processInfo.environment["HUSH_DEMO_URL"] { app.launchArguments += ["-demo-url", url] }
        app.launch()
        app.buttons["Try the demo"].tap()
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

    private func scrollTo(_ element: XCUIElement) {
        for _ in 0..<8 where !element.isHittable { app.swipeUp() }
    }

    func testAWebsiteHasItsOwnSectionAndPage() {
        launch()
        let site = card("Stillwater website")
        XCTAssertTrue(card("Stillwater").waitForExistence(timeout: 15))
        scrollTo(site)
        XCTAssertTrue(app.staticTexts["Websites"].exists)
        XCTAssertTrue(app.staticTexts["Reached the goal"].exists)
        snap("website-overview")
        site.tap()

        XCTAssertTrue(app.staticTexts["Visitors"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Visits with a store click"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["Active installs"].exists, "a website has no installs")
        snap("website")
        let sources = app.staticTexts["Sources"]
        scrollTo(sources)
        XCTAssertTrue(app.staticTexts["google.com"].exists)
        snap("website-sources")
        scrollTo(app.staticTexts["Devices"])
        XCTAssertTrue(app.staticTexts["Landing pages"].exists)
        snap("website-devices")

        let pages = card("Pages and clicks")
        scrollTo(pages)
        pages.tap()
        XCTAssertTrue(app.staticTexts["Top pages"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["/features"].waitForExistence(timeout: 15))
        snap("website-pages")
    }

    func testAShopShowsItsRevenueBySourceAndCampaign() {
        launch()
        let shop = card("Stillwater shop")
        XCTAssertTrue(card("Stillwater").waitForExistence(timeout: 15))
        scrollTo(shop)
        XCTAssertTrue(shop.staticTexts["Revenue"].exists, "a shop's card shows its revenue")
        XCTAssertTrue(shop.staticTexts["Orders"].exists)
        snap("shop-overview")
        shop.tap()

        XCTAssertTrue(app.staticTexts["Visits with an order completed"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Average order"].waitForExistence(timeout: 15))
        snap("shop")
        let bySource = app.staticTexts["Revenue by source"]
        scrollTo(bySource)
        XCTAssertTrue(app.staticTexts["Direct"].exists)
        // The shop's catalog funnel, in visitors.
        let funnel = app.staticTexts["Shop"]
        scrollTo(funnel)
        XCTAssertTrue(funnel.exists)
        snap("shop-funnel")
        let byCampaign = app.staticTexts["Revenue by campaign"]
        scrollTo(byCampaign)
        XCTAssertTrue(app.staticTexts["Meta autumn · meta"].waitForExistence(timeout: 5))
        snap("shop-revenue")
    }

    func testASiteThatSellsAnAppHasNoRevenue() {
        launch()
        let site = card("Stillwater website")
        XCTAssertTrue(card("Stillwater").waitForExistence(timeout: 15))
        scrollTo(site)
        site.tap()
        XCTAssertTrue(app.staticTexts["Visits with a store click"].waitForExistence(timeout: 15))
        scrollTo(app.staticTexts["Devices"])
        XCTAssertFalse(app.staticTexts["Revenue by source"].exists)
        XCTAssertFalse(app.staticTexts["Paywall"].exists, "no paywall funnel on a website")
    }

    func testAnAppShowsTheWebsitesThatSellIt() {
        launch()
        let stillwater = card("Stillwater")
        XCTAssertTrue(stillwater.waitForExistence(timeout: 15))
        stillwater.tap()
        XCTAssertTrue(app.staticTexts["Active installs"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Sold on stillwater-site"].exists)
        let websites = card("Websites")
        scrollTo(websites)
        websites.tap()
        XCTAssertTrue(app.staticTexts["By campaign"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["meta_autumn"].waitForExistence(timeout: 15))
        snap("app-websites")
    }
}
