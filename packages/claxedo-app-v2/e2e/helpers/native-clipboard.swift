import AppKit
import Darwin

enum ClipboardFailure: Error {
    case fixture, snapshot, changed, install, restore
}

func emit(_ status: String) {
    FileHandle.standardOutput.write(Data((status + "\n").utf8))
}

func run() throws {
    guard CommandLine.arguments.count == 2,
          let png = NSData(contentsOfFile: CommandLine.arguments[1]) as Data?,
          png.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
          let image = NSBitmapImageRep(data: png), image.pixelsWide > 0, image.pixelsHigh > 0
    else { throw ClipboardFailure.fixture }

    let pasteboard = NSPasteboard.general
    let originalCount = pasteboard.changeCount
    let originalItems = try (pasteboard.pasteboardItems ?? []).map { item in
        let copy = NSPasteboardItem()
        for type in item.types {
            guard let data = item.data(forType: type), copy.setData(data, forType: type)
            else { throw ClipboardFailure.snapshot }
        }
        return copy
    }
    guard pasteboard.changeCount == originalCount else { throw ClipboardFailure.changed }

    let markerType = NSPasteboard.PasteboardType("com.claxedo.e2e.clipboard-owner")
    let marker = UUID().uuidString
    let fixture = NSPasteboardItem()
    guard fixture.setData(png, forType: .png), fixture.setString(marker, forType: markerType)
    else { throw ClipboardFailure.fixture }

    // NSPasteboard has no compare-and-swap operation; keep each ownership check adjacent to its write.
    guard pasteboard.changeCount == originalCount else { throw ClipboardFailure.changed }
    let clearedCount = pasteboard.clearContents()
    let installed = pasteboard.writeObjects([fixture])
    let ownedCount = pasteboard.changeCount
    let ownsMarker = pasteboard.string(forType: markerType) == marker
    guard installed && ownsMarker else {
        if pasteboard.changeCount == clearedCount ||
            (ownsMarker && pasteboard.changeCount == ownedCount && pasteboard.string(forType: markerType) == marker) {
            pasteboard.clearContents()
            guard originalItems.isEmpty || pasteboard.writeObjects(originalItems) else {
                throw ClipboardFailure.restore
            }
        }
        throw ClipboardFailure.install
    }

    emit("installed")
    // EOF also arrives when the test process dies; the snapshot never leaves this process's memory.
    _ = readLine()
    guard pasteboard.changeCount == ownedCount,
          pasteboard.string(forType: markerType) == marker,
          pasteboard.changeCount == ownedCount else {
        emit("superseded")
        return
    }
    pasteboard.clearContents()
    guard originalItems.isEmpty || pasteboard.writeObjects(originalItems) else {
        throw ClipboardFailure.restore
    }
    emit("restored")
}

signal(SIGPIPE, SIG_IGN)
do {
    try run()
} catch let error as ClipboardFailure {
    emit("error:\(error)")
    exit(1)
} catch {
    emit("error:unknown")
    exit(1)
}
