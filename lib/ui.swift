import Cocoa
import Foundation

// 极简 GUI 自动化：点击 / 按键 / 输入文字（用于脚本 API 写不到的偏好设置开关）
func post(_ event: CGEvent?) { event?.post(tap: .cghidEventTap) }

func click(_ x: CGFloat, _ y: CGFloat, right: Bool = false) {
    let pt = CGPoint(x: x, y: y)
    let down = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: pt, mouseButton: right ? .right : .left)
    let up = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: pt, mouseButton: right ? .right : .left)
    post(down); usleep(60_000); post(up)
}

func press(_ code: CGKeyCode, flags: CGEventFlags = []) {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    down?.flags = flags
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    up?.flags = flags
    post(down); usleep(50_000); post(up)
}

func type(_ text: String) {
    for scalar in text.utf16 {
        var ch = scalar
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
        post(down)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
        post(up)
        usleep(20_000)
    }
}

var args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : ""
func opt(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
switch cmd {
case "click":
    guard let x = opt("--x").flatMap(Double.init), let y = opt("--y").flatMap(Double.init) else {
        print("{\"error\":\"click 需要 --x --y\"}"); exit(1)
    }
    click(x, y, right: args.contains("--right"))
    print("{\"ok\":true}")
case "key":
    guard let code = opt("--code").flatMap(UInt16.init) else { print("{\"error\":\"key 需要 --code\"}"); exit(1) }
    var flags: CGEventFlags = []
    if args.contains("--cmd") { flags.insert(.maskCommand) }
    if args.contains("--shift") { flags.insert(.maskShift) }
    if args.contains("--alt") { flags.insert(.maskAlternate) }
    press(CGKeyCode(code), flags: flags)
    print("{\"ok\":true}")
case "type":
    guard let text = opt("--text") else { print("{\"error\":\"type 需要 --text\"}"); exit(1) }
    type(text)
    print("{\"ok\":true}")
default:
    print("{\"error\":\"用法: click --x N --y N | key --code N [--cmd] | type --text ...\"}")
    exit(1)
}
