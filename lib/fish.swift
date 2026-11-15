import AppKit
import Foundation

// 肥鱼卡通贴图（透明底 PNG），用于「印在衣服上」的合成
let W = 600, H = 430
let img = NSImage(size: NSSize(width: W, height: H))
img.lockFocus()
guard let ctx = NSGraphicsContext.current?.cgContext else { exit(1) }
ctx.clear(CGRect(x: 0, y: 0, width: W, height: H))
func c(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGColor { CGColor(red: r/255, green: g/255, blue: b/255, alpha: 1) }

// 尾鳍
ctx.setFillColor(c(255, 138, 61))
ctx.beginPath()
ctx.move(to: CGPoint(x: 470, y: 215))
ctx.addLine(to: CGPoint(x: 588, y: 150))
ctx.addLine(to: CGPoint(x: 588, y: 280))
ctx.closePath(); ctx.fillPath()

// 身体（大肥鱼）
ctx.setFillColor(c(255, 174, 82))
ctx.beginPath()
ctx.addEllipse(in: CGRect(x: 95, y: 105, width: 390, height: 235))
ctx.fillPath()
// 白肚皮
ctx.setFillColor(c(255, 240, 214))
ctx.beginPath()
ctx.addEllipse(in: CGRect(x: 130, y: 105, width: 320, height: 120))
ctx.fillPath()
// 鳍
ctx.setFillColor(c(255, 130, 50))
ctx.beginPath()
ctx.move(to: CGPoint(x: 255, y: 330)); ctx.addLine(to: CGPoint(x: 330, y: 330)); ctx.addLine(to: CGPoint(x: 292, y: 395))
ctx.closePath(); ctx.fillPath()
// 眼睛
ctx.setFillColor(c(255, 255, 255))
ctx.beginPath(); ctx.addEllipse(in: CGRect(x: 150, y: 215, width: 52, height: 52)); ctx.fillPath()
ctx.setFillColor(c(30, 30, 35))
ctx.beginPath(); ctx.addEllipse(in: CGRect(x: 168, y: 230, width: 24, height: 24)); ctx.fillPath()
// 微笑
ctx.setStrokeColor(c(120, 60, 30)); ctx.setLineWidth(9); ctx.setLineCap(.round)
ctx.beginPath(); ctx.move(to: CGPoint(x: 128, y: 190)); ctx.addQuadCurve(to: CGPoint(x: 215, y: 178), control: CGPoint(x: 172, y: 205)); ctx.strokePath()
// 鳃线
ctx.setStrokeColor(c(230, 120, 40)); ctx.setLineWidth(7)
ctx.beginPath(); ctx.move(to: CGPoint(x: 330, y: 150)); ctx.addQuadCurve(to: CGPoint(x: 330, y: 300), control: CGPoint(x: 292, y: 225)); ctx.strokePath()
// 鳞片点缀
ctx.setFillColor(c(255, 205, 130))
for i in 0..<3 {
    let x = CGFloat(360 + i * 34)
    ctx.beginPath(); ctx.addEllipse(in: CGRect(x: x, y: 225, width: 30, height: 22)); ctx.fillPath()
}
img.unlockFocus()
guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/fish.png"))
print("wrote png \(W)x\(H)")
