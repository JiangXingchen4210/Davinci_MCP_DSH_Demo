import AVFoundation
import Foundation
import Speech

// 语音转写（macOS Speech 框架，本地/系统识别器）
// 用法：asr --in <audio.wav> [--locale zh-CN] [--on-device] [--json <out>] [--timeout 120]
// stdout 只输出 JSON：{ok, locale, segments:[{start,end,text,confidence}], text}

func die(_ message: String) -> Never {
    let payload: [String: Any] = ["ok": false, "error": message]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    }
    exit(1)
}

var inputPath: String?
var localeId = "zh-CN"
var onDevice = false
var outputPath: String?
var timeout: Double = 180

var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
    switch arg {
    case "--in": inputPath = args.next()
    case "--locale": localeId = args.next() ?? localeId
    case "--on-device": onDevice = true
    case "--json": outputPath = args.next()
    case "--timeout": timeout = Double(args.next() ?? "180") ?? 180
    default: break
    }
}

guard let path = inputPath else { die("缺少 --in <audio>") }
guard FileManager.default.fileExists(atPath: path) else { die("文件不存在：\(path)") }

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
    die("系统没有 \(localeId) 识别器")
}
guard recognizer.isAvailable else { die("识别器当前不可用（可能未联网/未授权）") }

// 权限：已授权直接用；未决定则尝试弹窗（最多等 8s）；被拒绝直接给出修复指引
let status = SFSpeechRecognizer.authorizationStatus()
if status != .authorized {
    if status == .denied || status == .restricted {
        die("语音识别被拒绝：系统设置 → 隐私与安全性 → 语音识别，勾选当前终端/DSH 后重试")
    }
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    SFSpeechRecognizer.requestAuthorization { newStatus in
        granted = newStatus == .authorized
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + 8) == .timedOut || !granted {
        die("语音识别未授权（无界面环境无法弹窗）：请在 系统设置 → 隐私与安全性 → 语音识别 中授权，或改用 --text 传入台词")
    }
}

let semaphore = DispatchSemaphore(value: 0)
var request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
request.shouldReportPartialResults = false
if onDevice {
    if #available(macOS 13.0, *) { request.requiresOnDeviceRecognition = true }
}

var segments: [[String: Any]] = []
var fullText = ""
var finished = false
var lastError: String?

let task = recognizer.recognitionTask(with: request) { result, error in
    if let error = error {
        lastError = error.localizedDescription
        if !finished { finished = true; semaphore.signal() }
        return
    }
    guard let result = result, result.isFinal else { return }
    fullText = result.bestTranscription.formattedString
    segments = result.bestTranscription.segments.map { segment in
        [
            "start": segment.timestamp,
            "end": segment.timestamp + segment.duration,
            "text": segment.substring,
            "confidence": Double(segment.confidence),
        ]
    }
    if !finished { finished = true; semaphore.signal() }
}

if semaphore.wait(timeout: .now() + timeout) == .timedOut {
    task.cancel()
    let payload: [String: Any] = ["ok": false, "error": "识别超时（\(Int(timeout))s）"]
    if let data = try? JSONSerialization.data(withJSONObject: payload), let text = String(data: data, encoding: .utf8) { print(text) }
    exit(1)
}

if let error = lastError, segments.isEmpty {
    let payload: [String: Any] = ["ok": false, "error": error]
    if let data = try? JSONSerialization.data(withJSONObject: payload), let text = String(data: data, encoding: .utf8) { print(text) }
    exit(1)
}

let payload: [String: Any] = [
    "ok": true,
    "locale": localeId,
    "onDevice": onDevice,
    "text": fullText,
    "segments": segments,
]
guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { die("序列化失败") }
if let outputPath = outputPath {
    try? data.write(to: URL(fileURLWithPath: outputPath))
}
if let text = String(data: data, encoding: .utf8) { print(text) }
