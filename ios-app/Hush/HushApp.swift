import HushKit
import SwiftUI

@main
struct HushApp: App {
    var body: some Scene {
        WindowGroup {
            // Until servers can be added, the app shows the public demo.
            NavigationStack {
                OverviewView(client: AdminClient(.demo))
            }
        }
    }
}
