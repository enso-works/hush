import XCTest

/// The first launch, against the live demo: needs the network.
@MainActor
final class OnboardingTests: XCTestCase {
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launch()
        return app
    }

    func testTheDemoFromTheWelcomeScreen() {
        let app = launch()
        app.buttons["Try the demo"].tap()
        XCTAssertTrue(app.staticTexts["Stillwater"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.navigationBars["Demo"].exists)
    }

    func testAddingAServerChecksItFirst() {
        let app = launch()
        app.buttons["Add your server"].tap()
        let address = app.textFields["hush.example.com"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        // Pasted as a browser shows it: the form drops /dashboard/.
        address.tap()
        address.typeText("hush.bavrk.com/demo/dashboard/")
        app.buttons["Connect"].tap()
        XCTAssertTrue(app.staticTexts["Tally"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.navigationBars["hush.bavrk.com"].exists)

        app.tabBars.buttons["Servers"].tap()
        XCTAssertTrue(app.staticTexts["https://hush.bavrk.com/demo"].exists)
    }

    func testAWrongAddressIsSaidSo() {
        let app = launch()
        app.buttons["Add your server"].tap()
        let address = app.textFields["hush.example.com"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap()
        address.typeText("example.com")
        app.buttons["Connect"].tap()
        // example.com answers /admin/session with a page that is not hush.
        let problem = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'not what a hush server sends' OR label CONTAINS 'answered'")).firstMatch
        XCTAssertTrue(problem.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Connect"].exists) // still on the form, nothing saved
    }
}
