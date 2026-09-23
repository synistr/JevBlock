import SwiftUI

@main
struct JevBlockApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    var body: some View {
        NavigationStack {
            List {
                Section("Turn it on") {
                    Label("Open Settings > Apps > Safari > Extensions", systemImage: "gearshape")
                    Label("Turn on JevBlock", systemImage: "switch.2")
                    Label("Allow it on all websites", systemImage: "globe")
                }
                Section("Use it") {
                    Label("In Safari, tap the page menu and JevBlock to see what it hid", systemImage: "puzzlepiece.extension")
                    Label("Categories, model and API key live in the extension's settings", systemImage: "slider.horizontal.3")
                }
            }
            .navigationTitle("JevBlock")
        }
    }
}

#Preview {
    ContentView()
}
