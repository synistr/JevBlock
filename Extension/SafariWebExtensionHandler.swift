import SafariServices

/// Native side of the web extension. Everything runs in JavaScript; this only acknowledges
/// `browser.runtime.sendNativeMessage` calls so Safari never waits on it.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: [], completionHandler: nil)
    }
}
