// vision.swift — macOS 原生 Vision 抠图 / 矩形跟踪 / 显著性框 命令行工具
//
// 编译（由 lib/cutout.mjs 自动执行并缓存）：
//   xcrun -sdk macosx swiftc -O lib/vision.swift -o lib/.build/vision
//
// 子命令：
//   cutout --in <img> --out <png>
//       VNGenerateForegroundInstanceMaskRequest（首选，抠任意显著前景实例）
//       → 不可用/无实例时退 VNGeneratePersonSegmentationRequest（人像分割）
//       把掩膜乘到原图 alpha 上，写带 alpha 的 RGBA PNG（背景透明）。
//       stdout: {"ok":true,"method":"foreground-instance|person-segmentation",
//                "width":W,"height":H,"coverage":0.12}
//   track --from <first.png> --box x,y,w,h --frames <f1.png>,<f2.png>,...
//       VNSequenceRequestHandler + VNTrackObjectRequest 逐帧跟踪。
//       stdout: {"ok":true,"frames":[{"path":...,"x":..,"y":..,"w":..,"h":..,"confidence":..}]}
//       坐标均为像素、左上原点（Vision 归一化坐标是左下原点，已换算）。
//   salient-box --in <img>
//       VNGenerateAttentionBasedSaliencyImageRequest，取面积最大的显著框。
//       stdout: {"ok":true,"box":{"x":..,"y":..,"w":..,"h":..}}
//   detect-rect --in <img> [--out-json [path]]
//   detect-face --in <img> [--out-json [path]] [--max 8]
//   ocr --in <img> [--lang zh-Hans,en-US] [--out-json [path]]
//       VNDetectRectanglesRequest（minimumAspectRatio 0.2 / minimumSize 0.1 /
//       quadratureTolerance 30 / maximumObservations 3）检测矩形（车窗/屏幕/海报）。
//       stdout: {"ok":true,"width":W,"height":H,
//                "rects":[{"corners":[{x,y}×4 顺时针],"confidence":..,"aspectRatio":..}],
//                "best":{…}}
//       corners 顺序固定：左上 → 右上 → 右下 → 左下（像素、左上原点）。
//       --out-json 后跟路径时额外写一份 JSON 文件；不带路径则只走 stdout。
//
// 失败：stdout 输出 {"ok":false,"error":"…"}，退出码 1（编译警告不算失败）。
// 依赖：仅系统框架（Foundation / Vision / ImageIO / CoreGraphics / CoreVideo）。

import Foundation
import Vision
import ImageIO
import CoreGraphics
import CoreVideo
import Darwin

// MARK: - stdout / stderr

/// 输出单行 JSON 到 stdout。用 FileHandle 直写，避免 exit() 前 stdio 缓冲丢失。
func emitJSON(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let str = String(data: data, encoding: .utf8) else {
        FileHandle.standardOutput.write(Data(#"{"ok":false,"error":"json encode failed"}"#.utf8))
        FileHandle.standardOutput.write(Data("\n".utf8))
        return
    }
    FileHandle.standardOutput.write(Data((str + "\n").utf8))
}

func emitError(_ message: String) -> Int32 {
    emitJSON(["ok": false, "error": message])
    FileHandle.standardError.write(Data((message + "\n").utf8))
    return 1
}

// MARK: - 图像读写

func loadCGImage(_ path: String) -> CGImage? {
    guard FileManager.default.fileExists(atPath: path) else { return nil }
    let url = URL(fileURLWithPath: path)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
    return img
}

func writePNG(_ image: CGImage, to path: String) -> Bool {
    let url = URL(fileURLWithPath: path)
    do {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
    } catch {
        return false
    }
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        return false
    }
    CGImageDestinationAddImage(dest, image, nil)
    return CGImageDestinationFinalize(dest)
}

/// 已解成逐像素直通道（non-premultiplied）RGBA8 的图像，行 0 = 图像顶部。
struct StraightRGBA {
    let width: Int
    let height: Int
    var bytes: [UInt8]
}

/// 用 sRGB RGBA8 premultipliedLast 位图上下文解码 CGImage（内存行 0 = 顶部行，
/// 与 CGContext 的左下原点坐标相反——CoreGraphics 位图上下文数据是顶向下的），
/// 再把 RGB 反预乘成直通道值，方便之后直接写 PNG（PNG 的 alpha 是直通道）。
func decodeStraightRGBA(_ cg: CGImage) -> StraightRGBA? {
    let w = cg.width
    let h = cg.height
    guard w > 0, h > 0 else { return nil }
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    let info = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    let ok: Bool = buf.withUnsafeMutableBytes { raw -> Bool in
        guard let ctx = CGContext(data: raw.baseAddress,
                                  width: w, height: h,
                                  bitsPerComponent: 8,
                                  bytesPerRow: w * 4,
                                  space: colorSpace,
                                  bitmapInfo: info) else { return false }
        ctx.interpolationQuality = .high
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        return true
    }
    guard ok else { return nil }
    // 反预乘（原图可能自带 alpha；本工具也要求输出直通道 PNG）
    for i in stride(from: 0, to: buf.count, by: 4) {
        let a = Int(buf[i + 3])
        if a == 0 || a == 255 { continue }
        let inv = 255.0 / Double(a)
        buf[i]     = UInt8(min(255, max(0, Int((Double(buf[i]) * inv).rounded()))))
        buf[i + 1] = UInt8(min(255, max(0, Int((Double(buf[i + 1]) * inv).rounded()))))
        buf[i + 2] = UInt8(min(255, max(0, Int((Double(buf[i + 2]) * inv).rounded()))))
    }
    return StraightRGBA(width: w, height: h, bytes: buf)
}

/// 从直通道 RGBA8 数据造 CGImage（alpha = .last，PNG 语义正确）。
/// 若系统不接受 non-premultiplied CGImage，则退化为 premultipliedLast。
func makeCGImage(from img: StraightRGBA) -> CGImage? {
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    let data = Data(img.bytes)
    guard let provider = CGDataProvider(data: data as CFData) else { return nil }
    let alphaLast = CGImageAlphaInfo.last.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    if let cg = CGImage(width: img.width, height: img.height,
                        bitsPerComponent: 8, bitsPerPixel: 32,
                        bytesPerRow: img.width * 4,
                        space: colorSpace,
                        bitmapInfo: CGBitmapInfo(rawValue: alphaLast),
                        provider: provider, decode: nil,
                        shouldInterpolate: false, intent: .defaultIntent) {
        return cg
    }
    // 退化：先预乘再写（ImageIO 写 PNG 时会转回直通道）
    var premul = img.bytes
    for i in stride(from: 0, to: premul.count, by: 4) {
        let a = Double(premul[i + 3]) / 255.0
        premul[i]     = UInt8((Double(premul[i]) * a).rounded())
        premul[i + 1] = UInt8((Double(premul[i + 1]) * a).rounded())
        premul[i + 2] = UInt8((Double(premul[i + 2]) * a).rounded())
    }
    let alphaPre = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    guard let p2 = CGDataProvider(data: Data(premul) as CFData) else { return nil }
    return CGImage(width: img.width, height: img.height,
                   bitsPerComponent: 8, bitsPerPixel: 32,
                   bytesPerRow: img.width * 4,
                   space: colorSpace,
                   bitmapInfo: CGBitmapInfo(rawValue: alphaPre),
                   provider: p2, decode: nil,
                   shouldInterpolate: false, intent: .defaultIntent)
}

// MARK: - 掩膜采样（支持与图像不同分辨率 / 8bit / 16half / 32float）

/// 把 CVPixelBuffer 掩膜解成 [Float]（0…1，行 0 = 顶部），提供归一化双线性采样。
struct MaskSampler {
    let width: Int
    let height: Int
    let data: [Float]

    /// normX / normY 都是 0…1，normY 从图像顶部算起。
    func sample(normX: Double, normY: Double) -> Double {
        guard width > 0, height > 0 else { return 0 }
        let fx = min(max(normX * Double(width) - 0.5, 0), Double(width - 1))
        let fy = min(max(normY * Double(height) - 0.5, 0), Double(height - 1))
        let x0 = Int(fx), y0 = Int(fy)
        let x1 = min(x0 + 1, width - 1), y1 = min(y0 + 1, height - 1)
        let tx = fx - Double(x0), ty = fy - Double(y0)
        let v00 = Double(data[y0 * width + x0])
        let v10 = Double(data[y0 * width + x1])
        let v01 = Double(data[y1 * width + x0])
        let v11 = Double(data[y1 * width + x1])
        let top = v00 * (1 - tx) + v10 * tx
        let bottom = v01 * (1 - tx) + v11 * tx
        return top * (1 - ty) + bottom * ty
    }

    func maxValue() -> Float { data.max() ?? 0 }
    func meanValue() -> Float {
        guard !data.isEmpty else { return 0 }
        return data.reduce(0, +) / Float(data.count)
    }
    /// 掩膜中值 >= threshold 的像素占全图的比例。
    func coverage(threshold: Float) -> Double {
        guard !data.isEmpty else { return 0 }
        var n = 0
        for v in data where v >= threshold { n += 1 }
        return Double(n) / Double(data.count)
    }
}

func maskSampler(from pixelBuffer: CVPixelBuffer) -> MaskSampler? {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    let w = CVPixelBufferGetWidth(pixelBuffer)
    let h = CVPixelBufferGetHeight(pixelBuffer)
    guard w > 0, h > 0, let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
    let bpr = CVPixelBufferGetBytesPerRow(pixelBuffer)
    let fmt = CVPixelBufferGetPixelFormatType(pixelBuffer)
    var out = [Float](repeating: 0, count: w * h)
    switch fmt {
    case kCVPixelFormatType_OneComponent8:
        for y in 0..<h {
            let row = base.advanced(by: y * bpr).assumingMemoryBound(to: UInt8.self)
            for x in 0..<w { out[y * w + x] = Float(row[x]) / 255.0 }
        }
    case kCVPixelFormatType_OneComponent32Float:
        for y in 0..<h {
            let row = base.advanced(by: y * bpr).assumingMemoryBound(to: Float.self)
            for x in 0..<w { out[y * w + x] = row[x] }
        }
    case kCVPixelFormatType_OneComponent16Half:
        for y in 0..<h {
            let row = base.advanced(by: y * bpr).assumingMemoryBound(to: UInt16.self)
            for x in 0..<w { out[y * w + x] = Float(Float16(bitPattern: row[x])) }
        }
    default:
        return nil
    }
    return MaskSampler(width: w, height: h, data: out)
}


// MARK: - 子命令：person-mask（只走 Apple 人物分割，输出灰度遮罩 PNG）

func runPersonMask(_ opts: [String: String]) -> Int32 {
    guard let inPath = opts["in"], !inPath.isEmpty else { return emitError("person-mask: missing --in <image>") }
    guard let outPath = opts["out"], !outPath.isEmpty else { return emitError("person-mask: missing --out <png>") }
    guard let cg = loadCGImage(inPath) else { return emitError("person-mask: cannot read image: \(inPath)") }
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    let req = VNGeneratePersonSegmentationRequest()
    req.qualityLevel = .accurate
    req.outputPixelFormat = kCVPixelFormatType_OneComponent8
    do { try handler.perform([req]) } catch {
        return emitError("person-mask: Vision failed: \(error)")
    }
    guard let obs = req.results?.first else { return emitError("person-mask: no observation") }
    let pb = obs.pixelBuffer
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    let stride = CVPixelBufferGetBytesPerRow(pb)
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return emitError("person-mask: no base address") }
    let cs = CGColorSpaceCreateDeviceGray()
    guard let ctx = CGContext(data: base, width: w, height: h, bitsPerComponent: 8, bytesPerRow: stride, space: cs, bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
        CVPixelBufferUnlockBaseAddress(pb, .readOnly)
        return emitError("person-mask: cannot wrap buffer")
    }
    guard let outCG = ctx.makeImage() else { CVPixelBufferUnlockBaseAddress(pb, .readOnly); return emitError("person-mask: cannot make image") }
    CVPixelBufferUnlockBaseAddress(pb, .readOnly)
    let url = URL(fileURLWithPath: outPath)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        return emitError("person-mask: cannot create png destination")
    }
    CGImageDestinationAddImage(dest, outCG, nil)
    guard CGImageDestinationFinalize(dest) else { return emitError("person-mask: cannot write png") }
    var covered = 0
    let ptr = base.assumingMemoryBound(to: UInt8.self)
    for y in 0..<h { for x in 0..<w where ptr[y * stride + x] > 127 { covered += 1 } }
    emitJSON(["ok": true, "width": w, "height": h, "coverage": Double(covered) / Double(w * h), "outputPath": outPath])
    return 0
}

// MARK: - 子命令：cutout

/// 生成前景掩膜：首选 foreground instance，失败/空掩膜退 person segmentation。
/// 返回 (method, sampler)。
func foregroundMask(for cg: CGImage) -> (String, MaskSampler)? {
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])

    if #available(macOS 14.0, *) {
        let req = VNGenerateForegroundInstanceMaskRequest()
        do {
            try handler.perform([req])
            if let obs = req.results?.first, !obs.allInstances.isEmpty,
               let buf = try? obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler),
               let sampler = maskSampler(from: buf), sampler.coverage(threshold: 0.5) >= 0.001 {
                return ("foreground-instance", sampler)
            }
        } catch {
            FileHandle.standardError.write(Data("foreground-instance mask failed: \(error)\n".utf8))
        }
    }

    // 退：人像分割（背景透明遮罩）
    let personReq = VNGeneratePersonSegmentationRequest()
    personReq.qualityLevel = .accurate
    personReq.outputPixelFormat = kCVPixelFormatType_OneComponent8
    do {
        try handler.perform([personReq])
        if let obs = personReq.results?.first,
           let sampler = maskSampler(from: obs.pixelBuffer),
           sampler.coverage(threshold: 0.5) >= 0.005 {
            return ("person-segmentation", sampler)
        }
    } catch {
        FileHandle.standardError.write(Data("person-segmentation failed: \(error)\n".utf8))
    }
    return nil
}

func runCutout(_ opts: [String: String]) -> Int32 {
    guard let inPath = opts["in"], !inPath.isEmpty else {
        return emitError("cutout: missing --in <image>")
    }
    guard let outPath = opts["out"], !outPath.isEmpty else {
        return emitError("cutout: missing --out <png>")
    }
    guard let cg = loadCGImage(inPath) else {
        return emitError("cutout: cannot read image: \(inPath)")
    }
    guard let rgba = decodeStraightRGBA(cg) else {
        return emitError("cutout: cannot decode image pixels: \(inPath)")
    }
    guard let (method, sampler) = foregroundMask(for: cg) else {
        return emitError("cutout: Vision found no foreground instance and no person (mask coverage too small)")
    }

    let w = rgba.width, h = rgba.height
    var out = rgba.bytes
    var covered = 0
    for y in 0..<h {
        let ny = (Double(y) + 0.5) / Double(h)
        for x in 0..<w {
            let nx = (Double(x) + 0.5) / Double(w)
            let m = sampler.sample(normX: nx, normY: ny)
            let i = (y * w + x) * 4
            let originalAlpha = Double(rgba.bytes[i + 3]) / 255.0
            let a = originalAlpha * m
            let a8 = UInt8(min(255, max(0, Int((a * 255.0).rounded()))))
            out[i + 3] = a8
            if a8 > 127 { covered += 1 }
        }
    }

    guard let outCG = makeCGImage(from: StraightRGBA(width: w, height: h, bytes: out)) else {
        return emitError("cutout: cannot build output image")
    }
    guard writePNG(outCG, to: outPath) else {
        return emitError("cutout: cannot write PNG: \(outPath)")
    }
    let coverage = Double(covered) / Double(w * h)
    emitJSON([
        "ok": true,
        "method": method,
        "width": w,
        "height": h,
        "coverage": cleanNum(coverage, 4),
    ])
    return 0
}

// MARK: - 子命令：track

func runTrack(_ opts: [String: String]) -> Int32 {
    guard let firstPath = opts["from"], !firstPath.isEmpty else {
        return emitError("track: missing --from <first.png>")
    }
    guard let boxStr = opts["box"], !boxStr.isEmpty else {
        return emitError("track: missing --box x,y,w,h")
    }
    guard let framesStr = opts["frames"], !framesStr.isEmpty else {
        return emitError("track: missing --frames <f1.png>,<f2.png>,...")
    }
    let parts = boxStr.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }
    guard parts.count == 4,
          let bx = Double(parts[0]), let by = Double(parts[1]),
          let bw = Double(parts[2]), let bh = Double(parts[3]),
          bw > 0, bh > 0 else {
        return emitError("track: invalid --box \"\(boxStr)\" (expected x,y,w,h in pixels)")
    }
    guard let firstCG = loadCGImage(firstPath) else {
        return emitError("track: cannot read first frame: \(firstPath)")
    }
    let framePaths = framesStr.split(separator: ",")
        .map { String($0).trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
    guard !framePaths.isEmpty else {
        return emitError("track: --frames is empty")
    }

    let firstW = Double(firstCG.width), firstH = Double(firstCG.height)
    // 像素（左上原点）→ Vision 归一化（左下原点）
    let norm = CGRect(x: bx / firstW,
                      y: 1.0 - (by + bh) / firstH,
                      width: bw / firstW,
                      height: bh / firstH)
    guard norm.minX >= 0, norm.minY >= 0, norm.maxX <= 1, norm.maxY <= 1 else {
        return emitError("track: --box \(boxStr) is outside the \(firstCG.width)x\(firstCG.height) image")
    }

    let sequenceHandler = VNSequenceRequestHandler()
    let request = VNTrackObjectRequest(detectedObjectObservation:
                                       VNDetectedObjectObservation(boundingBox: norm))
    request.trackingLevel = .accurate

    var currentObservation: VNDetectedObjectObservation?
    do {
        try sequenceHandler.perform([request], on: firstCG, orientation: .up)
        currentObservation = request.results?.first as? VNDetectedObjectObservation
    } catch {
        return emitError("track: initial frame failed: \(error.localizedDescription)")
    }
    guard currentObservation != nil else {
        return emitError("track: Vision could not initialize tracking on the first frame")
    }

    var results: [[String: Any]] = []
    var lostAt: Int? = nil
    var lastBox = (x: bx, y: by, w: bw, h: bh)
    var lastConfidence = 0.0

    for (idx, path) in framePaths.enumerated() {
        guard let cg = loadCGImage(path) else {
            return emitError("track: cannot read frame[\(idx)]: \(path)")
        }
        guard let obs = currentObservation else {
            lostAt = idx
            break
        }
        let nextRequest = VNTrackObjectRequest(detectedObjectObservation: obs)
        nextRequest.trackingLevel = .accurate
        do {
            try sequenceHandler.perform([nextRequest], on: cg, orientation: .up)
        } catch {
            // 单帧失败：记录最后已知框（confidence 0），继续尝试后续帧
            results.append(["path": path,
                            "x": cleanNum(lastBox.x, 2), "y": cleanNum(lastBox.y, 2),
                            "w": cleanNum(lastBox.w, 2), "h": cleanNum(lastBox.h, 2),
                            "confidence": 0.0])
            lostAt = idx
            currentObservation = nil
            continue
        }
        guard let newObs = nextRequest.results?.first as? VNDetectedObjectObservation else {
            results.append(["path": path,
                            "x": cleanNum(lastBox.x, 2), "y": cleanNum(lastBox.y, 2),
                            "w": cleanNum(lastBox.w, 2), "h": cleanNum(lastBox.h, 2),
                            "confidence": 0.0])
            lostAt = idx
            currentObservation = nil
            continue
        }
        // Vision 归一化（左下原点）→ 像素（左上原点）
        let bb = newObs.boundingBox
        let W = Double(cg.width), H = Double(cg.height)
        let px = bb.minX * W
        let py = (1.0 - bb.maxY) * H
        let pw = bb.width * W
        let ph = bb.height * H
        lastBox = (px, py, pw, ph)
        lastConfidence = Double(newObs.confidence)
        currentObservation = newObs
        results.append(["path": path,
                        "x": cleanNum(px, 2), "y": cleanNum(py, 2),
                        "w": cleanNum(pw, 2), "h": cleanNum(ph, 2),
                        "confidence": cleanNum(lastConfidence, 3)])
    }

    var payload: [String: Any] = ["ok": true, "frames": results]
    if let lostAt = lostAt { payload["lostAt"] = lostAt }
    emitJSON(payload)
    return 0
}

// MARK: - 子命令：salient-box

func runSalientBox(_ opts: [String: String]) -> Int32 {
    guard let inPath = opts["in"], !inPath.isEmpty else {
        return emitError("salient-box: missing --in <image>")
    }
    guard let cg = loadCGImage(inPath) else {
        return emitError("salient-box: cannot read image: \(inPath)")
    }
    let request = VNGenerateAttentionBasedSaliencyImageRequest()
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return emitError("salient-box: Vision request failed: \(error.localizedDescription)")
    }
    guard let obs = request.results?.first as? VNSaliencyImageObservation else {
        return emitError("salient-box: no saliency result")
    }
    let objects = (obs.salientObjects ?? []).filter { $0.boundingBox.width > 0 && $0.boundingBox.height > 0 }
    guard let best = objects.max(by: {
        $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height
    }) else {
        return emitError("salient-box: Vision found no salient object")
    }
    let bb = best.boundingBox
    let W = Double(cg.width), H = Double(cg.height)
    let x = bb.minX * W
    let y = (1.0 - bb.maxY) * H
    let w = bb.width * W
    let h = bb.height * H
    emitJSON(["ok": true,
              "box": ["x": cleanNum(x, 2), "y": cleanNum(y, 2),
                      "w": cleanNum(w, 2), "h": cleanNum(h, 2)],
              "confidence": cleanNum(Double(best.confidence), 3)])
    return 0
}

// MARK: - 子命令：detect-rect

/// 检测画面中的矩形（车窗 / 屏幕 / 海报 / 广告牌），输出 4 个角点（像素、左上原点）。
/// Vision 的 VNRectangleObservation 角点是归一化坐标、左下原点，这里统一换算。
func runDetectRect(_ opts: [String: String]) -> Int32 {
    guard let inPath = opts["in"], !inPath.isEmpty else {
        return emitError("detect-rect: missing --in <image>")
    }
    guard let cg = loadCGImage(inPath) else {
        return emitError("detect-rect: cannot read image: \(inPath)")
    }
    let request = VNDetectRectanglesRequest()
    request.minimumAspectRatio = 0.2
    request.minimumSize = 0.1
    request.quadratureTolerance = 30
    request.maximumObservations = 3
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return emitError("detect-rect: Vision request failed: \(error.localizedDescription)")
    }
    guard let observations = request.results, !observations.isEmpty else {
        return emitError("detect-rect: Vision found no rectangle in \(inPath)")
    }

    let W = Double(cg.width), H = Double(cg.height)
    // Vision 归一化（左下原点）→ 像素（左上原点）
    func pixel(_ p: CGPoint) -> [String: Any] {
        ["x": cleanNum(p.x * W, 2), "y": cleanNum((1.0 - p.y) * H, 2)]
    }
    func edge(_ a: CGPoint, _ b: CGPoint) -> Double {
        let dx = (a.x - b.x) * W
        let dy = (a.y - b.y) * H
        return (dx * dx + dy * dy).squareRoot()
    }

    // (confidence, payload) —— 最后按置信度降序，best 取最高
    var items: [(Double, [String: Any])] = []
    for obs in observations {
        // 图像坐标 y 向下时，这个顺序就是顺时针：左上 → 右上 → 右下 → 左下
        let corners = [pixel(obs.topLeft), pixel(obs.topRight),
                       pixel(obs.bottomRight), pixel(obs.bottomLeft)]
        let avgW = (edge(obs.topLeft, obs.topRight) + edge(obs.bottomLeft, obs.bottomRight)) / 2.0
        let avgH = (edge(obs.topLeft, obs.bottomLeft) + edge(obs.topRight, obs.bottomRight)) / 2.0
        let aspect = avgH > 0 ? avgW / avgH : 0
        items.append((Double(obs.confidence), [
            "corners": corners,
            "confidence": cleanNum(Double(obs.confidence), 3),
            "aspectRatio": cleanNum(aspect, 3),
        ]))
    }
    items.sort { $0.0 > $1.0 }
    let rects = items.map { $0.1 }

    var payload: [String: Any] = [
        "ok": true,
        "width": cg.width,
        "height": cg.height,
        "rects": rects,
    ]
    if let best = rects.first { payload["best"] = best }

    // --out-json 后面若跟了路径，额外写一份 JSON 文件（stdout 照常输出，方便管道）
    if let outPath = opts["out-json"], !outPath.isEmpty {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return emitError("detect-rect: cannot encode JSON")
        }
        do {
            try text.write(toFile: outPath, atomically: true, encoding: .utf8)
        } catch {
            return emitError("detect-rect: cannot write \(outPath): \(error.localizedDescription)")
        }
    }
    emitJSON(payload)
    return 0
}

// MARK: - 工具

/// 输出“干净”的小数：JSONSerialization 对 Double 会打印 17 位有效数字
/// （如 65.540000000000006），包成 NSDecimalNumber 才能得到 65.54 这种可读值。
func cleanNum(_ v: Double, _ places: Int) -> NSDecimalNumber {
    let f = pow(10.0, Double(places))
    let scaled = Int64((v * f).rounded())
    return NSDecimalNumber(mantissa: UInt64(abs(scaled)),
                           exponent: Int16(-places),
                           isNegative: scaled < 0)
}

func usage() {
    FileHandle.standardError.write(Data("""
    usage:
      vision cutout --in <img> --out <png>
      vision track --from <first.png> --box x,y,w,h --frames <f1.png>,<f2.png>,...
      vision salient-box --in <img>
      vision detect-rect --in <img> [--out-json [path]]

    """.utf8))
}

// MARK: - 入口（单文件编译时该文件即 main.swift 语义，顶层代码直接作为入口）

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first, !command.hasPrefix("--") else {
    usage()
    exit(emitError("missing subcommand (cutout | track | salient-box | detect-rect)"))
}
var opts: [String: String] = [:]
var i = 1
while i < args.count {
    let key = args[i]
    if key.hasPrefix("--") {
        let name = String(key.dropFirst(2))
        if i + 1 < args.count {
            opts[name] = args[i + 1]
            i += 2
        } else {
            opts[name] = ""
            i += 1
        }
    } else {
        i += 1
    }
}
let code: Int32
// MARK: - 子命令：detect-face（人脸 / 人体矩形，供跟踪调色用）

/// 检测画面里的人脸与人体（像素坐标、左上原点），供「面向对象调色」决定局部区域。
func runDetectFace(_ opts: [String: String]) -> Int32 {
    guard let inPath = opts["in"], !inPath.isEmpty else {
        return emitError("detect-face: missing --in <image>")
    }
    guard let cg = loadCGImage(inPath) else {
        return emitError("detect-face: cannot read image: \(inPath)")
    }
    let maxCount = Int(opts["max"] ?? "8") ?? 8
    let W = Double(cg.width), H = Double(cg.height)

    var faces: [[String: Any]] = []
    let faceRequest = VNDetectFaceRectanglesRequest()
    do {
        try VNImageRequestHandler(cgImage: cg, options: [:]).perform([faceRequest])
        for obs in (faceRequest.results ?? []).prefix(maxCount) {
            let box = obs.boundingBox
            var item: [String: Any] = [
                "x": cleanNum(box.origin.x * W, 1),
                "y": cleanNum((1.0 - box.origin.y - box.height) * H, 1),
                "w": cleanNum(box.width * W, 1),
                "h": cleanNum(box.height * H, 1),
                "confidence": cleanNum(Double(obs.confidence), 3),
            ]
            if let roll = obs.roll, let yaw = obs.yaw {
                item["roll"] = cleanNum(roll.doubleValue, 3)
                item["yaw"] = cleanNum(yaw.doubleValue, 3)
            }
            faces.append(item)
        }
    } catch {
        return emitError("detect-face: face request failed: \(error.localizedDescription)")
    }

    var bodies: [[String: Any]] = []
    let humanRequest = VNDetectHumanRectanglesRequest()
    do {
        try VNImageRequestHandler(cgImage: cg, options: [:]).perform([humanRequest])
        for obs in (humanRequest.results ?? []).prefix(maxCount) {
            let box = obs.boundingBox
            bodies.append([
                "x": cleanNum(box.origin.x * W, 1),
                "y": cleanNum((1.0 - box.origin.y - box.height) * H, 1),
                "w": cleanNum(box.width * W, 1),
                "h": cleanNum(box.height * H, 1),
                "confidence": cleanNum(Double(obs.confidence), 3),
            ])
        }
    } catch {
        // 人体检测失败不影响人脸结果
    }

    emitJSON([
        "ok": true,
        "width": cg.width,
        "height": cg.height,
        "faces": faces,
        "bodies": bodies,
        "faceCount": faces.count,
        "bodyCount": bodies.count,
    ])
    return 0
}

// MARK: - 子命令：ocr（剧本/分镜/场记单的图片文字识别）

/// 图片 OCR：中文（简/繁）+ 英文，按行输出文本与位置（像素、左上原点）。
func runOCR(_ opts: [String: String]) -> Int32 {
    guard let inPath = opts["in"], !inPath.isEmpty else {
        return emitError("ocr: missing --in <image>")
    }
    guard let cg = loadCGImage(inPath) else {
        return emitError("ocr: cannot read image: \(inPath)")
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let langs = (opts["lang"] ?? "zh-Hans,zh-Hant,en-US").split(separator: ",").map { String($0) }
    request.recognitionLanguages = langs
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return emitError("ocr: Vision request failed: \(error.localizedDescription)")
    }
    let W = Double(cg.width), H = Double(cg.height)
    var lines: [[String: Any]] = []
    for obs in (request.results ?? []) {
        guard let candidate = obs.topCandidates(1).first else { continue }
        let box = obs.boundingBox
        lines.append([
            "text": candidate.string,
            "confidence": cleanNum(Double(candidate.confidence), 3),
            "x": cleanNum(box.origin.x * W, 1),
            "y": cleanNum((1.0 - box.origin.y - box.height) * H, 1),
            "w": cleanNum(box.width * W, 1),
            "h": cleanNum(box.height * H, 1),
        ])
    }
    // 按上→下、左→右排序（阅读顺序）
    lines.sort { a, b in
        let ay = (a["y"] as? Double) ?? 0
        let by = (b["y"] as? Double) ?? 0
        if abs(ay - by) > 8 { return ay < by }
        let ax = (a["x"] as? Double) ?? 0
        let bx = (b["x"] as? Double) ?? 0
        return ax < bx
    }
    let text = lines.compactMap { $0["text"] as? String }.joined(separator: "\n")
    emitJSON([
        "ok": true,
        "width": cg.width,
        "height": cg.height,
        "lines": lines,
        "text": text,
        "lineCount": lines.count,
    ])
    return 0
}

switch command {
case "cutout":      code = runCutout(opts)
case "track":       code = runTrack(opts)
case "salient-box": code = runSalientBox(opts)
case "detect-rect": code = runDetectRect(opts)
case "detect-face": code = runDetectFace(opts)
case "ocr": code = runOCR(opts)
case "person-mask": code = runPersonMask(opts)
default:
    usage()
    code = emitError("unknown subcommand: \(command)")
}
exit(code)
