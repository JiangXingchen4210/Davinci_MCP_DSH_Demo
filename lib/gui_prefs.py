"""GUI 自动化：状态感知地设置 Resolve 偏好里的两个开关（OCR 定位 + 取样读状态 + 点击 + 回读确认）。"""
import json, subprocess, sys, time, os
import numpy as np, cv2

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(HERE, '.build/ui')
VIS = os.path.join(HERE, '.build/vision')
SHOT = '/tmp/resolve-prefs-gui.png'
import platform as _platform_module
PLATFORM = 'darwin' if sys.platform == 'darwin' else 'win32'
# 平台映射：macOS / Windows 的开关名称与存在性不同，分开处理，每项独立上报
ROWS = {
    'darwin': [
        ('displayColorProfile', ['为检视器使用Mac显示色彩描述文件', 'Use Mac Display Color Profiles for Viewers'], False, True),
        ('tag709a', ['自动为Rec.709', 'Automatically tag Rec.709 clips as Rec.709-A'], True, True),
    ],
    'win32': [
        ('displayColorProfile', ['为检视器使用Windows显示色彩描述文件', 'Use Windows display color profiles for viewers'], False, False),
        ('tag709a', ['自动为Rec.709', 'Automatically tag Rec.709 clips as Rec.709-A'], True, True),
    ],
}[PLATFORM]

def labels_hit(text, needles):
    return any(n.lower() in text.lower() for n in needles)

def shot():
    subprocess.run(['screencapture', '-x', SHOT], check=True)
    img = cv2.imread(SHOT)
    return img

def ocr():
    out = subprocess.run([VIS, 'ocr', '--in', SHOT], capture_output=True, text=True).stdout
    try:
        return json.loads(out)['lines']
    except Exception:
        return []

def find_row(lines, needles):
    if isinstance(needles, str):
        needles = [needles]
    for l in lines:
        if labels_hit(l['text'], needles):
            return l
    return None

def checkbox_point(line):
    # 复选框在文字左侧；图像是 2x retina，CGEvent 用点坐标 → /2
    px = (line['x'] - 34) / 2.0
    py = (line['y'] + line['h'] / 2) / 2.0
    return int(px), int(py)

def label_point(line):
    # 实测：点标签文字本身也能切换（旧脚本就是这样成功的）
    return int((line['x'] + line['w'] / 2) / 2), int((line['y'] + line['h'] / 2) / 2)

def read_state(img, line):
    """在复选框区域取色：蓝色填充=已勾选；灰暗=未勾选。"""
    cx, cy = checkbox_point(line)
    x0, y0 = int(cx * 2) - 10, int(cy * 2) - 10
    patch = img[max(0, y0):y0 + 20, max(0, x0):x0 + 20].astype(np.float32)
    b, g, r = patch[:, :, 0].mean(), patch[:, :, 1].mean(), patch[:, :, 2].mean()
    gray = patch.mean(axis=2)
    # 勾选时是白色对勾（有高亮像素），未勾选是暗色方框
    bright_frac = float((gray > 150).mean())
    checked = bright_frac > 0.04
    return {'blue_bias': float(b - r), 'brightness': float((b + g + r) / 3), 'bright_frac': bright_frac, 'checked': checked}

def click(x, y):
    subprocess.run([UI, 'click', '--x', str(x), '--y', str(y)], check=False)

report = {'ok': True, 'rows': [], 'screenshot': SHOT}
# 先激活 Resolve 并打开偏好设置（Cmd+,）
subprocess.run(['osascript', '-e', 'tell application "DaVinci Resolve" to activate'], capture_output=True)
time.sleep(0.8)
subprocess.run([UI, 'key', '--code', '43', '--cmd'], capture_output=True)
time.sleep(2.0)
img = shot()
lines = ocr()
regular = find_row(lines, ['常规', 'General'])
if regular:
    click(int(regular['x'] / 2), int((regular['y'] + regular['h'] / 2) / 2))
    time.sleep(0.8)
    img = shot(); lines = ocr()

for key, needles, want, applicable in ROWS:
    row = find_row(lines, needles)
    if not row:
        status = 'not_found' if applicable else 'not_applicable'
        report['rows'].append({'name': key, 'found': False, 'status': status, 'platform': PLATFORM})
        if applicable:
            report['ok'] = False
        continue
    state = read_state(img, row)
    actions = []
    for attempt in range(3):
        if state['checked'] == want:
            break
        cx, cy = checkbox_point(row)
        click(cx, cy)
        time.sleep(0.5)
        img = shot()
        lines2 = ocr()
        row2 = find_row(lines2, key) or row
        state = read_state(img, row2)
        actions.append({'attempt': attempt + 1, 'after': state['checked']})
    report['rows'].append({'name': key, 'found': True, 'platform': PLATFORM, 'target': want, 'final': state['checked'], 'ok': state['checked'] == want, 'actions': actions})
    if state['checked'] != want:
        report['ok'] = False

# 保存
lines = ocr()
save = find_row(lines, ['保存', 'Save', 'OK'])
if save:
    click(int((save['x'] + save['w'] / 2) / 2), int((save['y'] + save['h'] / 2) / 2))
    report['saved'] = True
else:
    report['saved'] = False
print(json.dumps(report, ensure_ascii=False))
