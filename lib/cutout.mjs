// cutout.mjs — macOS Vision 抠图 / 矩形跟踪 / 显著性框 的 Node ESM 包装
//
// 底层是单文件 Swift 命令行工具 lib/vision.swift。首次调用时自动编译并缓存：
//   xcrun -sdk macosx swiftc -O lib/vision.swift -o lib/.build/vision
// 源文件 mtime 比二进制新（或二进制不存在）才重新编译。零 npm 依赖。
//
// 导出：
//   cutoutImage(inputPath, outputPath)  → { ok, method, width, height, coverage, outputPath }
//   trackBox(firstFramePath, box, framePaths)
//       box = { x, y, w, h } 或 [x, y, w, h]（像素、左上原点）
//       → { ok, frames: [{ path, x, y, w, h, confidence }], lostAt }
//   salientBox(imagePath)               → { ok, box: {x,y,w,h}, confidence }
//   detectRectangles(imagePath)         → { ok, width, height, rects, best }
//       rects[i].corners 是 4 个角点（像素、左上原点），顺序固定顺时针：
//       左上 → 右上 → 右下 → 左下；rects 已按 confidence 降序。
//   ensureBinary({ force })             → { path, compiled, ms }（测试/预热用）
//   getCompileInfo()                    → { binary, source, compileMs }
//
// 失败时 throw Error，message 含子命令与原因，err.stderr / err.stdout 保留原始输出，
// 编译失败时 stderr 就是 swiftc 的原始报错。

import { spawn } from 'node:child_process';
import { statSync, promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs'
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LIB_DIR = __dirname;
export const SWIFT_SOURCE = path.join(__dirname, 'vision.swift');
export const BUILD_DIR = path.join(__dirname, '.build');
export const BINARY_PATH = path.join(BUILD_DIR, 'vision');

const COMPILE_TIMEOUT_MS = 180_000;  // 冷启动（首次编译 + Swift 模块缓存）实测 ~35s，留足余量
const RUN_TIMEOUT_MS = 120_000;

let compilePromise = null;
let lastCompileMs = null;

export function getCompileInfo() {
    return { binary: BINARY_PATH, source: SWIFT_SOURCE, compileMs: lastCompileMs };
}

function errorWithContext(message, { stdout = '', stderr = '', code = null, cause = null } = {}) {
    const parts = [message];
    if (stderr.trim()) parts.push(`stderr: ${stderr.trim()}`);
    const err = new Error(parts.join('\n'));
    err.stdout = stdout;
    err.stderr = stderr;
    err.code = code;
    if (cause) err.cause = cause;
    return err;
}

/** 源文件是否比已编译二进制新（二进制缺失也算需要重编） */
function needsRebuild() {
    try {
        const src = statSync(SWIFT_SOURCE);
        const bin = statSync(BINARY_PATH);
        return bin.mtimeMs < src.mtimeMs;
    } catch {
        return true;
    }
}

/** spawn 一个命令，收集 stdout/stderr，永不 reject（由调用方看 code）。 */
function runCommand(command, args, { timeoutMs = RUN_TIMEOUT_MS, cwd } = {}) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const child = spawn(command, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });
        const timer = timeoutMs > 0
            ? setTimeout(() => {
                if (settled) return;
                settled = true;
                try { child.kill('SIGKILL'); } catch { /* ignore */ }
                resolve({ code: null, signal: 'SIGKILL', stdout, stderr: stderr + `\n[timeout] ${command} exceeded ${timeoutMs}ms` });
            }, timeoutMs)
            : null;

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve({ code: -1, signal: null, stdout, stderr: stderr + `\n[spawn error] ${err.message}`, spawnError: err });
        });
        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

/**
 * 确保二进制可用：不存在或比 swift 源码旧时编译并缓存。
 * 并发调用共享同一个编译 Promise，不会重复编译。
 * @param {{force?: boolean}} opts force=true 时强制重编（测试测编译耗时用）
 */
export async function ensureBinary({ force = false } = {}) {
    // 优先使用随包发布的预编译程序（bin/davinci-vision）：干净解包即可运行，不需要 Swift 工具链
    if (!force) {
        const packaged = path.join(__dirname, '..', 'bin', 'davinci-vision');
        // 只在没有本机编译产物时用随包预编译程序（干净解包场景）；开发机仍按源码 mtime 重编
        try {
            const hasLocal = existsSync(BINARY_PATH);
            if (!hasLocal && existsSync(packaged)) return { path: packaged, compiled: false, ms: 0 };
        } catch { /* 忽略 */ }
    }
    if (!force && !needsRebuild()) {
        return { path: BINARY_PATH, compiled: false, ms: 0 };
    }
    if (compilePromise) return compilePromise;

    compilePromise = (async () => {
        await fsp.mkdir(BUILD_DIR, { recursive: true });
        const startedAt = Date.now();

        // 任务要求的编译入口：xcrun -sdk macosx swiftc -O …
        let result = await runCommand(
            'xcrun',
            ['-sdk', 'macosx', 'swiftc', '-O', SWIFT_SOURCE, '-o', BINARY_PATH],
            { timeoutMs: COMPILE_TIMEOUT_MS },
        );

        // xcrun/SDK 缺失时退回 PATH 上的 swiftc（编译产物一致）
        const xcrunBroken = result.code !== 0 && /unable to find utility|SDK .*cannot be located|No such file|not found/i.test(result.stderr + result.stdout);
        if (xcrunBroken) {
            result = await runCommand('swiftc', ['-O', SWIFT_SOURCE, '-o', BINARY_PATH], { timeoutMs: COMPILE_TIMEOUT_MS });
        }

        const ms = Date.now() - startedAt;
        if (result.code !== 0) {
            throw errorWithContext(
                `vision.swift 编译失败（swiftc exit=${result.code}，耗时 ${ms}ms）。请确认已安装 Xcode Command Line Tools（xcrun -sdk macosx --show-sdk-path）。`,
                result,
            );
        }
        lastCompileMs = ms;
        return { path: BINARY_PATH, compiled: true, ms };
    })().finally(() => {
        compilePromise = null;
    });

    return compilePromise;
}

/** 运行 vision 子命令；解析 stdout 最后一行 JSON；ok=false 或非 0 退出码都 throw。 */
async function runVision(args, { timeoutMs = RUN_TIMEOUT_MS } = {}) {
    const bin = await ensureBinary();
    const result = await runCommand(bin.path, args, { timeoutMs });
    const stdout = (result.stdout || '').trim();
    const lastLine = stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
    let parsed = null;
    try {
        parsed = lastLine ? JSON.parse(lastLine) : null;
    } catch {
        parsed = null;
    }
    if (parsed === null) {
        throw errorWithContext(
            `vision ${args[0]} 没有输出可解析的 JSON（exit=${result.code}）`,
            result,
        );
    }
    if (result.code !== 0 || parsed.ok !== true) {
        throw errorWithContext(
            `vision ${args[0]} 失败: ${parsed.error || `exit=${result.code}`}`,
            result,
        );
    }
    return parsed;
}

function toAbsolute(p) {
    if (typeof p !== 'string' || p.length === 0) throw new TypeError('路径必须是非空字符串');
    return path.resolve(p);
}

function normalizeBox(box) {
    const values = Array.isArray(box)
        ? box
        : box && typeof box === 'object'
            ? [box.x, box.y, box.w ?? box.width, box.h ?? box.height]
            : null;
    if (!values || values.length !== 4) {
        throw new TypeError('box 必须是 {x,y,w,h} 或 [x,y,w,h]');
    }
    const [x, y, w, h] = values.map(Number);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
        throw new TypeError(`box 数值无效: ${JSON.stringify(box)}`);
    }
    return { x, y, w, h };
}

/**
 * 抠图：把图片的显著前景实例（或人像）抠出来，背景透明，写带 alpha 的 PNG。
 * @param {string} inputPath
 * @param {string} outputPath
 */
export async function cutoutImage(inputPath, outputPath) {
    const inPath = toAbsolute(inputPath);
    const outPath = toAbsolute(outputPath);
    const parsed = await runVision(['cutout', '--in', inPath, '--out', outPath]);
    return {
        ok: true,
        method: parsed.method,
        width: parsed.width,
        height: parsed.height,
        coverage: parsed.coverage,
        outputPath: outPath,
    };
}

/**
 * 矩形跟踪：用第一帧与初始框初始化 VNTrackObjectRequest，逐帧输出跟踪框。
 * @param {string} firstFramePath 初始化帧（通常是序列首帧）
 * @param {{x:number,y:number,w:number,h:number}|number[]} box 初始框，像素、左上原点
 * @param {string[]} framePaths 后续帧，按顺序输出
 */
export async function trackBox(firstFramePath, box, framePaths) {
    const firstPath = toAbsolute(firstFramePath);
    const b = normalizeBox(box);
    if (!Array.isArray(framePaths) || framePaths.length === 0) {
        throw new TypeError('framePaths 必须是非空字符串数组');
    }
    const frames = framePaths.map(toAbsolute);
    const parsed = await runVision([
        'track',
        '--from', firstPath,
        '--box', `${b.x},${b.y},${b.w},${b.h}`,
        '--frames', frames.join(','),
    ]);
    return {
        ok: true,
        frames: (parsed.frames || []).map((f) => ({
            path: f.path,
            x: f.x,
            y: f.y,
            w: f.w,
            h: f.h,
            confidence: f.confidence,
        })),
        lostAt: parsed.lostAt ?? null,
    };
}

/**
 * 显著性框：取注意力显著图中面积最大的物体框（像素、左上原点）。
 * @param {string} imagePath
 */
export async function salientBox(imagePath) {
    const inPath = toAbsolute(imagePath);
    const parsed = await runVision(['salient-box', '--in', inPath]);
    return { ok: true, box: parsed.box, confidence: parsed.confidence };
}

/**
 * 矩形检测：用 VNDetectRectanglesRequest 找画面中的矩形（车窗 / 屏幕 / 海报），
 * 输出 4 个角点（像素、左上原点），顺序固定顺时针：左上 → 右上 → 右下 → 左下。
 * rects 按 confidence 降序，best 是置信度最高的一条。
 * @param {string} imagePath
 * @returns {Promise<{ok:boolean,width:number,height:number,rects:Array,best:object|null}>}
 */
export async function detectRectangles(imagePath) {
    const inPath = toAbsolute(imagePath);
    const parsed = await runVision(['detect-rect', '--in', inPath]);
    const rects = (parsed.rects || []).map((rect) => ({
        corners: (rect.corners || []).map((corner) => ({ x: corner.x, y: corner.y })),
        confidence: rect.confidence,
        aspectRatio: rect.aspectRatio,
    }));
    return {
        ok: true,
        width: parsed.width,
        height: parsed.height,
        rects,
        best: rects[0] ?? null,
    };
}
