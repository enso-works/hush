import XCTest

/// Remote config and Phones against a real, writable server: PAIR_LINK
/// (TEST_RUNNER_PAIR_LINK) from its /admin/pairing, on a server whose
/// catalog gives Stillwater a string key `paywall_variant`. Skipped without
/// one. It overrides that key's default and reverts it.
@MainActor
final class ConfigTests: XCTestCase {
    private var app: XCUIApplication!

    private func snap(_ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["SCREENSHOTS_DIR"] else { return }
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(component: "\(name).png"))
    }

    func testEditingAndRevertingAKey() throws {
        guard let raw = ProcessInfo.processInfo.environment["PAIR_LINK"], let url = URL(string: raw) else { throw XCTSkip("PAIR_LINK not set") }
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launch()
        app.open(url)
        XCTAssertTrue(app.buttons["Connect"].waitForExistence(timeout: 10))
        app.buttons["Connect"].tap()

        let card = app.buttons.containing(.staticText, identifier: "Stillwater").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        card.tap()
        let config = app.buttons.containing(.staticText, identifier: "Remote config").firstMatch
        for _ in 0..<4 where !config.isHittable { app.swipeUp() }
        config.tap()
        let row = app.buttons.containing(.staticText, identifier: "paywall_variant").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        snap("config")
        row.tap()
        XCTAssertTrue(app.staticTexts["From the catalog."].waitForExistence(timeout: 10))
        snap("config-key")

        app.navigationBars.buttons["Edit"].tap()
        let field = app.descendants(matching: .any).matching(identifier: "value-Default").firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        // The cursor lands where the tap is: move it past the text first.
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4) + "c")
        let note = app.descendants(matching: .any).matching(NSPredicate(format: "placeholderValue == %@", "Why (optional)")).firstMatch
        if note.exists { note.tap(); note.typeText("UI test: copy c") }
        sleep(2)
        snap("config-edit")
        app.navigationBars.buttons["Save"].tap()

        XCTAssertTrue(app.staticTexts["Overridden"].waitForExistence(timeout: 10) || app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Overridden here")).firstMatch.waitForExistence(timeout: 5))
        snap("config-key-overridden")

        app.swipeUp()
        app.buttons["Revert to the Catalog"].tap()
        app.buttons["Revert"].tap()
        XCTAssertTrue(app.staticTexts["From the catalog."].waitForExistence(timeout: 10))
        snap("config-key-reverted")

        // Phones: this one is listed, and another can be signed in.
        let tab = app.tabBars.buttons["Settings"]
        (tab.exists ? tab : app.buttons["Settings"].firstMatch).tap()
        app.buttons.containing(.staticText, identifier: "Phones").firstMatch.tap()
        XCTAssertTrue(app.staticTexts["This phone"].waitForExistence(timeout: 10))
        snap("phones-list")
        app.buttons.containing(.staticText, identifier: "Sign In Another Phone").firstMatch.tap()
        XCTAssertTrue(app.images["QR code for signing in another phone"].waitForExistence(timeout: 10))
        snap("phones")
    }
}
