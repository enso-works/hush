import SwiftUI

/// First launch: no server yet.
struct WelcomeView: View {
    @Environment(AppModel.self) private var model
    @State private var adding = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            VStack(spacing: 8) {
                Text("hush").font(.largeTitle.bold())
                Text("Read and answer your users' feedback, and see how your apps are used, from your own hush server.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(spacing: 12) {
                Button {
                    adding = true
                } label: {
                    Text("Add your server").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button {
                    model.addDemo()
                } label: {
                    Text("Try the demo").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                Text("The demo shows invented apps and is read-only.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .controlSize(.large)
        }
        .padding(24)
        .sheet(isPresented: $adding) {
            NavigationStack { ServerForm(editing: nil) }
        }
    }
}
