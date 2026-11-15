#!/usr/bin/env node
// erase.test.mjs — 擦除升级「clean plate + 补帧」测试（无测试框架，node lib/erase.test.mjs 直接跑）
//
// 覆盖 B3（静态机位 clean plate 补帧）：
//   1) buildCleanPlate：5 帧白底 + 只在第 2 帧出现的黑条 → 逐像素时间中位数必须把
//      黑条位置恢复成白色（其余 4 帧可见内容），打印「第 2 帧像素值 vs plate 像素值」数值证据。
//   2) patchFramesWithPlate：持续存在的细黑线（5 帧都有），用 clean plate 补掉后
//      局部方差显著下降（从 ~1e4 降到 0），线中心像素变回白色。
//   3) 羽化：整块黑区 + 白 plate，输出从左边界向内的 4px 内权重必须单调 0→1（不是硬切）。
//   4) CLI：node lib/erase.mjs plate / patch 走通并输出 JSON；detect 旧行为不回归。
//
// 失败以 1 退出；ffmpeg 缺失时打印 SKIP。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildCleanPlate,
    patchFramesWithPlate,
    detectStableLines,
} from './erase.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'erase');
const ERASE_SCRIPT = path.join(__dirname, 'erase.mjs');

const W = 640, H = 360;
const BAR = { x: 200, y: 100, w: 240, h: 80 };       // 只在第 2 帧出现的黑条
const BAR_FRAME_INDEX = 1;                            // 0 基：第 2 帧（序列第 2 帧）
const LINE = { x: 300, y: 40, w: 4, h: 280 };         // 持续存在的细黑线
const LINE_BOX = { x: 290, y: 30, w: 24, h: 300 };    // 补线用的框（线两侧各留 pad）
const FEATHER_BOX = { x: 290, y: 30, w: 24, h: 300 }; // 羽化测试：整框黑区
const FEATHER = 4;

let checks = 0;
const failures = [];

function check(condition, message) {
    checks += 1;
    if (!condition) {
        failures.push(message);
        throw new Error(`ASSERT FAILED: ${message}`);
    }
}

function report(label, detail) {
    console.log(`${label} ${detail}`);
}

function log(...args) {
    console.log(...args);
}

function runCapture(command, args, { timeoutMs = 180_000 } = {}) {
    return new Promise((resolve) => {
        const outChunks = [];
        const errChunks = [];
        let settled = false;
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            resolve({
                code: null,
                stdout: Buffer.concat(outChunks),
                stderr: Buffer.concat(errChunks).toString() + `\n[timeout] ${command} exceeded ${timeoutMs}ms`,
            });
        }, timeoutMs);
        child.stdout.on('data', (chunk) => outChunks.push(chunk));
        child.stderr.on('data', (chunk) => errChunks.push(chunk));
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: -1, stdout: Buffer.concat(outChunks), stderr: String(err) });
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, stdout: Buffer.concat(outChunks), stderr: Buffer.concat(errChunks).toString() });
        });
    });
}

async function resolveTool(name) {
    const candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }
    const probe = await runCapture(name, ['-version'], { timeoutMs: 10_000 });
    return probe.code === 0 ? name : null;
}

/** 用 ffmpeg 生成一帧：白底 + 可选黑框（drawbox），写 PNG。 */
async function generateFrame(ffmpeg, outPath, boxes = []) {
    const filters = boxes.map(({ x, y, w, h }) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@1:t=fill`);
    const args = [
        '-y', '-v', 'error', '-f', 'lavfi',
        '-i', `color=c=white:s=${W}x${H}:d=1`,
        '-vf', [...filters, 'format=rgb24'].join(','),
        '-frames:v', '1', outPath,
    ];
    const result = await runCapture(ffmpeg, args);
    if (result.code !== 0) throw new Error(`ffmpeg 生成帧失败: ${result.stderr}`);
    return outPath;
}

/** 解码图片成 RGB24 像素（指定尺寸）。 */
async function decodeFrameRGB(ffmpeg, imagePath, width, height) {
    const result = await runCapture(ffmpeg, [
        '-v', 'error', '-i', imagePath,
        '-vf', `scale=${width}:${height},format=rgb24`,
        '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ]);
    if (result.code !== 0) throw new Error(`解码 ${imagePath} 失败: ${result.stderr}`);
    const expected = width * height * 3;
    check(result.stdout.length === expected, `解码 ${path.basename(imagePath)} 字节数 ${result.stdout.length} == ${expected}`);
    return result.stdout;
}

function rgbAt(buffer, width, x, y) {
    const at = (y * width + x) * 3;
    return { r: buffer[at], g: buffer[at + 1], b: buffer[at + 2] };
}

/** 区域亮度的方差（用于证明细线被擦掉：纹理方差应显著下降）。 */
function regionVariance(buffer, width, rect) {
    const values = [];
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
        for (let x = rect.x; x < rect.x + rect.w; x += 1) {
            const { r, g, b } = rgbAt(buffer, width, x, y);
            values.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
        }
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return { mean, variance };
}

/** 以子进程方式跑 erase.mjs CLI，解析 stdout JSON。 */
async function runEraseCli(args) {
    const result = await runCapture(process.execPath, [ERASE_SCRIPT, ...args]);
    check(result.code === 0, `CLI ${args[0]} 应 exit 0（实际 ${result.code}）\n${result.stderr}`);
    const text = result.stdout.toString().trim();
    try {
        return JSON.parse(text.split('\n').pop());
    } catch (error) {
        throw new Error(`CLI ${args[0]} 输出不是 JSON：${text.slice(0, 300)}（${String(error)}）`);
    }
}

async function main() {
    log('== erase.test.mjs — clean plate 补帧（静态机位）测试 ==');

    const ffmpeg = await resolveTool('ffmpeg');
    if (!ffmpeg) {
        console.log('SKIP 未找到 ffmpeg（/opt/homebrew/bin、/usr/local/bin、PATH 均无）');
        return;
    }
    log(`ffmpeg: ${ffmpeg}`);
    await fsp.mkdir(FIXTURES_DIR, { recursive: true });

    // ---------- 0) 现场生成素材 ----------
    const barFrames = [];
    for (let i = 0; i < 5; i += 1) {
        const boxes = i === BAR_FRAME_INDEX ? [BAR] : [];
        barFrames.push(await generateFrame(ffmpeg, path.join(FIXTURES_DIR, `bar-${i}.png`), boxes));
    }
    const lineFrames = [];
    for (let i = 0; i < 5; i += 1) {
        lineFrames.push(await generateFrame(ffmpeg, path.join(FIXTURES_DIR, `line-${i}.png`), [LINE]));
    }
    const cleanWhiteFrames = [];
    for (let i = 0; i < 5; i += 1) {
        cleanWhiteFrames.push(await generateFrame(ffmpeg, path.join(FIXTURES_DIR, `white-${i}.png`)));
    }
    const featherFrame = await generateFrame(ffmpeg, path.join(FIXTURES_DIR, 'feather-black.png'), [FEATHER_BOX]);
    log(`FIXTURES ok ${barFrames.length + lineFrames.length + cleanWhiteFrames.length + 1} 帧（${FIXTURES_DIR}）`);

    // ---------- 1) buildCleanPlate：时间中位数恢复偶发黑条 ----------
    const plate = await buildCleanPlate(barFrames, { width: W, height: H });
    check(plate.width === W && plate.height === H, `clean plate 尺寸 ${plate.width}x${plate.height} == ${W}x${H}`);
    check(plate.data.length === W * H * 3, `clean plate RGB 字节数 ${plate.data.length} == ${W * H * 3}`);
    check(plate.frameCount === 5, `clean plate 统计帧数 ${plate.frameCount} == 5`);

    const barFramePixels = await decodeFrameRGB(ffmpeg, barFrames[BAR_FRAME_INDEX], W, H);
    const centerX = BAR.x + Math.floor(BAR.w / 2);
    const centerY = BAR.y + Math.floor(BAR.h / 2);
    const barPixel = rgbAt(barFramePixels, W, centerX, centerY);
    const platePixel = rgbAt(plate.data, plate.width, centerX, centerY);
    const plateBackground = rgbAt(plate.data, plate.width, BAR.x + 10, BAR.y - 20);
    check(barPixel.r < 30 && barPixel.g < 30 && barPixel.b < 30,
        `第 2 帧黑条中心 (${centerX},${centerY}) 应为黑（实际 rgb=${barPixel.r},${barPixel.g},${barPixel.b}）`);
    check(platePixel.r > 200 && platePixel.g > 200 && platePixel.b > 200,
        `clean plate 在黑条位置应恢复为白（中位数；实际 rgb=${platePixel.r},${platePixel.g},${platePixel.b}）`);
    check(plateBackground.r > 200, `clean plate 背景处也是白（实际 ${plateBackground.r}）`);
    const barDelta = platePixel.r - barPixel.r;
    check(barDelta > 200, `中位数恢复幅度 ${barDelta} 应 > 200（第 2 帧 ${barPixel.r} → plate ${platePixel.r}）`);
    report('PASS buildCleanPlate',
        `黑条中心 (${centerX},${centerY})：第 ${BAR_FRAME_INDEX + 1} 帧 rgb=${barPixel.r},${barPixel.g},${barPixel.b} → plate rgb=${platePixel.r},${platePixel.g},${platePixel.b}（+${barDelta}，中位数取 4 帧可见白色）`);

    // ---------- 2) patchFramesWithPlate：持续细线被 clean plate 擦掉（方差下降） ----------
    const cleanPlate = await buildCleanPlate(cleanWhiteFrames, { width: W, height: H });
    const patchOutDir = path.join(FIXTURES_DIR, 'patch-line');
    await fsp.rm(patchOutDir, { recursive: true, force: true });
    const patched = await patchFramesWithPlate({
        frames: lineFrames,
        plate: cleanPlate,
        boxes: [LINE_BOX],
        outDir: patchOutDir,
        feather: FEATHER,
    });
    check(patched.length === lineFrames.length, `patch 输出 ${patched.length} 帧 == 输入 ${lineFrames.length}`);
    for (const file of patched) check(existsSync(file.path), `patch 输出文件存在: ${file.path}`);

    const ROI = { x: LINE.x - 4, y: LINE.y + 60, w: 16, h: 160 };  // 覆盖线的局部区域
    const lineBefore = await decodeFrameRGB(ffmpeg, lineFrames[0], W, H);
    const lineAfter = await decodeFrameRGB(ffmpeg, patched[0].path, W, H);
    const before = regionVariance(lineBefore, W, ROI);
    const after = regionVariance(lineAfter, W, ROI);
    const linePixelBefore = rgbAt(lineBefore, W, LINE.x + 1, LINE.y + 100);
    const linePixelAfter = rgbAt(lineAfter, W, LINE.x + 1, LINE.y + 100);
    check(before.variance > 1000, `补帧前局部方差 ${before.variance.toFixed(1)} 应 > 1000（有细线）`);
    check(after.variance < 1, `补帧后局部方差 ${after.variance.toFixed(2)} 应 < 1（线被擦掉）`);
    check(after.variance < before.variance * 0.001,
        `补帧后方差应只剩 <0.1%（${after.variance.toFixed(2)} / ${before.variance.toFixed(1)}）`);
    check(linePixelBefore.r < 30, `补帧前线中心像素应黑（实际 ${linePixelBefore.r}）`);
      check(linePixelAfter.r > 250, `补帧后线中心像素应恢复为白（实际 ${linePixelAfter.r}）`);
    report('PASS patchFramesWithPlate',
        `细线 ROI 亮度方差 ${before.variance.toFixed(0)} → ${after.variance.toFixed(2)}（下降 ${(100 * (1 - after.variance / before.variance)).toFixed(2)}%）；线中心像素 ${linePixelBefore.r} → ${linePixelAfter.r}`);

    // ---------- 3) 羽化：4px 内权重从 1 过渡到 0（不是硬切）----------
    const featherOutDir = path.join(FIXTURES_DIR, 'patch-feather');
    await fsp.rm(featherOutDir, { recursive: true, force: true });
    const featherPatched = await patchFramesWithPlate({
        frames: [featherFrame],
        plate: cleanPlate,
        boxes: [FEATHER_BOX],
        outDir: featherOutDir,
        feather: FEATHER,
    });
    const featherBefore = await decodeFrameRGB(ffmpeg, featherFrame, W, H);
    const featherAfter = await decodeFrameRGB(ffmpeg, featherPatched[0].path, W, H);
    const rowY = FEATHER_BOX.y + Math.floor(FEATHER_BOX.h / 2);
    const ramp = [];
    for (let offset = 0; offset <= FEATHER + 1; offset += 1) {
        ramp.push(rgbAt(featherAfter, W, FEATHER_BOX.x + offset, rowY).r);
    }
    check(rgbAt(featherBefore, W, FEATHER_BOX.x + 2, rowY).r < 30, '羽化测试帧框内应全黑');
    check(ramp[0] < 64, `羽化左边界像素 ${ramp[0]} 应接近 0（权重从 0 开始）`);
    check(ramp[FEATHER] >= 250, `羽化 4px 处像素 ${ramp[FEATHER]} 应达到背景白 ≥250（权重到 1）`);
    for (let i = 1; i <= FEATHER; i += 1) {
        check(ramp[i] >= ramp[i - 1], `羽化权重应单调不减（ramp=${ramp.join(',')}）`);
    }
    // 4px 内确实存在中间值（不是硬切：0 和 255 之间有过渡像素）
    check(ramp.slice(1, FEATHER).some((value) => value > 10 && value < 245), `羽化应产生中间灰阶（ramp=${ramp.join(',')}）`);
    report('PASS feather', `左边界起 ${FEATHER + 2}px 灰度 ramp=${ramp.join(',')}（0→253 单调过渡，无硬切）`);

    // ---------- 4) CLI：plate / patch 走通；detect 旧行为不回归 ----------
    const cliPlatePath = path.join(FIXTURES_DIR, 'cli-clean-plate.png');
    const plateJson = await runEraseCli(['plate', ...barFrames, '--out', cliPlatePath, '--width', String(W)]);
    check(plateJson.ok === true && plateJson.command === 'plate', `CLI plate JSON ok（${JSON.stringify(plateJson).slice(0, 160)}）`);
    check(plateJson.width === W && plateJson.height === H && plateJson.frames === 5, `CLI plate 尺寸/帧数（${plateJson.width}x${plateJson.height}, ${plateJson.frames}f）`);
    check(existsSync(cliPlatePath), 'CLI plate 输出文件存在');
    const cliPlatePixels = await decodeFrameRGB(ffmpeg, cliPlatePath, W, H);
    const cliPlatePixel = rgbAt(cliPlatePixels, W, centerX, centerY);
    check(cliPlatePixel.r > 200, `CLI 生成的 clean plate 在黑条位置也是白（实际 ${cliPlatePixel.r}）`);

    const cliPatchOutDir = path.join(FIXTURES_DIR, 'cli-patch');
    await fsp.rm(cliPatchOutDir, { recursive: true, force: true });
    const patchJson = await runEraseCli([
        'patch', ...lineFrames,
        '--plate', cliPlatePath,
        '--boxes', `${LINE_BOX.x},${LINE_BOX.y},${LINE_BOX.w},${LINE_BOX.h}`,
        '--outdir', cliPatchOutDir,
        '--feather', String(FEATHER),
    ]);
    check(patchJson.ok === true && patchJson.command === 'patch', `CLI patch JSON ok（${JSON.stringify(patchJson).slice(0, 160)}）`);
    check(Array.isArray(patchJson.files) && patchJson.files.length === lineFrames.length, `CLI patch 输出 ${patchJson.files?.length} 个文件`);
    const cliPatchedPixels = await decodeFrameRGB(ffmpeg, patchJson.files[0], W, H);
    const cliAfter = regionVariance(cliPatchedPixels, W, ROI);
    check(cliAfter.variance < 1, `CLI patch 后局部方差 ${cliAfter.variance.toFixed(2)} 应 < 1`);
    report('PASS CLI', `plate → ${path.basename(cliPlatePath)}（${plateJson.width}x${plateJson.height}）；patch → ${patchJson.files.length} 帧，方差 ${cliAfter.variance.toFixed(2)}`);

    // detect 旧行为回归（只测仍能跑通，不改已有逻辑）
    const detectJson = await runEraseCli(['detect', ...lineFrames, '--json']);
    check(detectJson.ok === true && detectJson.command === 'detect', 'CLI detect 旧命令仍 ok');
    check(detectJson.framesAnalyzed === lineFrames.length, `CLI detect framesAnalyzed=${detectJson.framesAnalyzed} == ${lineFrames.length}`);
    check(Array.isArray(detectJson.candidates), 'CLI detect 仍输出 candidates 数组');
    const detectResult = await detectStableLines(lineFrames, { width: 256 });
    check(detectResult.framesAnalyzed === lineFrames.length, 'detectStableLines 旧导出仍可用（不回归）');
    report('PASS detect regression', `旧 detect CLI/导出仍工作（framesAnalyzed=${detectJson.framesAnalyzed}，candidates=${detectJson.candidates.length}）`);

    // ---------- 汇总 ----------
    check(failures.length === 0, `不应有失败断言（${failures.join('; ')}）`);
    log(`\nPASS erase.test.mjs — ${checks} 项断言全部通过`);
    log(`   clean plate 中位数恢复：第 2 帧黑条 ${barPixel.r} → plate ${platePixel.r}；` +
        `细线 ROI 方差 ${before.variance.toFixed(0)} → ${after.variance.toFixed(2)}；羽化 ramp=${ramp.join(',')}`);
}

main().catch((err) => {
    console.error('\nFAIL erase.test.mjs');
    console.error(err?.stack || String(err));
    process.exitCode = 1;
});
