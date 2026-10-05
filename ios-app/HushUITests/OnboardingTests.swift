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

    /// With SCREENSHOTS_DIR set (TEST_RUNNER_SCREENSHOTS_DIR on the xcodebuild line), saves what the screen shows there.
    private func snap(_ app: XCUIApplication, _ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOTS_DIR"] else { return }
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(component: "\(name).png"))
    }

    func testTheOverviewAndAnAppsPage() {
        let app = launch()
        app.buttons["Try the demo"].tap()
        snap(app, "overview-loading")
        let card = app.buttons.containing(.staticText, identifier: "Stillwater").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Open feedback"].exists)
        snap(app, "overview")
        card.tap()
        XCTAssertTrue(app.staticTexts["Active installs"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Activity"].exists)
        snap(app, "app")
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["Retention"].waitForExistence(timeout: 5))
        snap(app, "app-retention")
    }

    func testRemovingAServerAsksFirst() {
        let app = launch()
        app.buttons["Try the demo"].tap()
        app.tabBars.buttons["Servers"].tap()
        let row = app.buttons.containing(.staticText, identifier: "Demo").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.swipeLeft()
        app.buttons["Remove"].firstMatch.tap()
        // Asked, not done: the server is still there until the answer.
        XCTAssertTrue(app.staticTexts["Remove Demo?"].waitForExistence(timeout: 5))
        XCTAssertTrue(row.exists)
        app.buttons.matching(identifier: "Remove").allElementsBoundByIndex.last?.tap()
        XCTAssertTrue(app.buttons["Try the demo"].waitForExistence(timeout: 5))
    }

    /// The demo's QR code holds no code: opening it connects without one.
    func testOpeningTheDemosPairingLink() {
        let app = launch()
        app.open(URL(string: "hush://pair?url=https%3A%2F%2Fhush.bavrk.com%2Fdemo")!)
        XCTAssertTrue(app.navigationBars["Connect to hush"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any).containing(NSPredicate(format: "label CONTAINS %@", "hush.bavrk.com")).firstMatch.exists)
        app.buttons["Connect"].tap()
        XCTAssertTrue(app.staticTexts["Stillwater"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.navigationBars["Demo"].exists)
    }

    /// A real code, against a real server: PAIR_LINK (TEST_RUNNER_PAIR_LINK on
    /// the xcodebuild line) from a server's /admin/pairing. Skipped without one.
    /// The server's /admin/devices then shows whether removing it revoked it.
    func testPairingWithACode() throws {
        guard let raw = ProcessInfo.processInfo.environment["PAIR_LINK"], let url = URL(string: raw) else { throw XCTSkip("PAIR_LINK not set") }
        let app = launch()
        app.open(url)
        XCTAssertTrue(app.navigationBars["Connect to hush"].waitForExistence(timeout: 10))
        let name = app.textFields["This phone's name"]
        name.tap()
        name.clearAndType("UI test iPhone")
        app.buttons["Connect"].tap()
        XCTAssertTrue(app.staticTexts["Open feedback"].waitForExistence(timeout: 15))

        // Removing the server signs this phone out on the server too.
        app.tabBars.buttons["Servers"].tap()
        let row = app.buttons.containing(.staticText, identifier: "127.0.0.1").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.swipeLeft()
        app.buttons["Remove"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["This phone is signed out on the server too. Connecting again needs a new code from the dashboard."].waitForExistence(timeout: 5))
        app.buttons.matching(identifier: "Remove").allElementsBoundByIndex.last?.tap()
        XCTAssertTrue(app.buttons["Try the demo"].waitForExistence(timeout: 5))
        sleep(2) // the revocation is sent as the row goes

        // The code is used up: the same link again is refused. (open() relaunches the app.)
        app.open(url)
        XCTAssertTrue(app.navigationBars["Connect to hush"].waitForExistence(timeout: 10))
        app.buttons["Connect"].tap()
        XCTAssertTrue(app.staticTexts["This code has been used or has expired. Show a new one on the dashboard."].waitForExistence(timeout: 10))
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

extension XCUIElement {
    func clearAndType(_ text: String) {
        let current = value as? String ?? ""
        typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        typeText(text)
    }
}
