#!/bin/bash
# 用 GUI（OCR 定位 + 点击）把 Resolve 两个脚本 API 写不到的偏好设置改掉：
#   1) 关掉 Use Mac Display Color Profiles for Viewers
#   2) 打开 Automatically tag Rec.709 clips as Rec.709-A
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
UI="$HERE/.build/ui"; VIS="$HERE/.build/vision"
WORK="/tmp/resolve-prefs-fix"; mkdir -p "$WORK"
shot() { screencapture -x "$WORK/screen.png"; }
ocr() { "$VIS" ocr --in "$WORK/screen.png" 2>/dev/null; }
# 点文字中心（screen.png 是 retina 2x，CGEvent 用点 → /2）
click_text() {
  local needle="$1" dy="${2:-0}" dx="${3:-0}"
  python3 - "$needle" "$dy" "$HERE" "$dx" <<'PY'
import json, subprocess, sys, os
needle, dy, here = sys.argv[1], float(sys.argv[2]), sys.argv[3]
vis = os.path.join(here, '.build/vision')
raw = subprocess.run([vis, 'ocr', '--in', '/tmp/resolve-prefs-fix/screen.png'], capture_output=True, text=True).stdout
try:
    data = json.loads(raw)
except Exception:
    print('OCR_PARSE_FAIL', raw[:120]); sys.exit(2)
lines = data.get('lines') or data.get('observations') or []
def text_of(line):
    return line.get('text') or ''.join(c.get('text','') for c in (line.get('candidates') or []) or [])
hits = [l for l in lines if needle.lower() in text_of(l).lower()]
if not hits:
    print('NOT_FOUND', needle); sys.exit(3)
l = hits[0]
x, y, w, h = l.get('x',0), l.get('y',0), l.get('w',0), l.get('h',0)
px = (x + w/2) / 2.0 + (float(sys.argv[4]) if len(sys.argv) > 4 else 0)
py = (y + h/2) / 2.0 + dy
print(f'CLICK {needle} -> {px:.0f},{py:.0f}')
subprocess.run([os.path.join(here,'.build/ui'), 'click', '--x', str(int(px)), '--y', str(int(py))])
PY
}
osascript -e 'tell application "DaVinci Resolve" to activate' >/dev/null 2>&1 || true
sleep 1
"$UI" key --code 43 --cmd >/dev/null   # Cmd+,
sleep 2
shot
click_text "常规" || echo "常规 未找到（可能已在常规页）"
sleep 1; shot
click_text "Mac 显示器" 0 -30 || click_text "色彩配置文件" 0 -30 || true
sleep 0.5; shot
click_text "Rec.709-A" 0 -30 || true
sleep 0.5
# 保存
shot; click_text "保存" || true
echo "done"
