#!/usr/bin/env python3
"""Vosk 离线语音转写（中文/英文）。

用法：
  python3 asr_transcribe.py --in audio.wav --model <vosk-model-dir> [--json out] [--sample-rate 16000]

输出（stdout 只出 JSON）：
  {ok, text, words:[{word,start,end,conf}], segments:[{start,end,text,conf}]}
segments 按停顿（>0.35s）或超长（>8s）切分，供剪辑引擎判断「整句」。
"""

import argparse
import json
import os
import sys
import wave


def fail(message):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="input", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--json", dest="output", default=None)
    parser.add_argument("--pause", type=float, default=0.35)
    parser.add_argument("--max-segment", type=float, default=8.0)
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        fail("音频文件不存在：%s" % args.input)
    if not os.path.isdir(args.model):
        fail("Vosk 模型目录不存在：%s" % args.model)

    try:
        import vosk
    except Exception as error:  # noqa: BLE001
        fail("未安装 vosk：%s" % error)

    vosk.SetLogLevel(-1)
    try:
        model = vosk.Model(args.model)
    except Exception as error:  # noqa: BLE001
        fail("加载 Vosk 模型失败：%s" % error)

    try:
        wav = wave.open(args.input, "rb")
    except Exception as error:  # noqa: BLE001
        fail("无法读取 wav（需要 16k/16bit/mono PCM）：%s" % error)

    if wav.getnchannels() != 1 or wav.getframerate() != 16000 or wav.getsampwidth() != 2:
        fail("音频格式必须是 16kHz/16bit/mono wav，当前：%sch/%sHz/%sbit" % (
            wav.getnchannels(), wav.getframerate(), wav.getsampwidth() * 8))

    recognizer = vosk.KaldiRecognizer(model, 16000)
    recognizer.SetWords(True)

    words = []
    texts = []
    while True:
        data = wav.readframes(4000)
        if len(data) == 0:
            break
        if recognizer.AcceptWaveform(data):
            result = json.loads(recognizer.Result())
            text = (result.get("text") or "").strip()
            if text:
                texts.append(text)
            for word in result.get("result", []) or []:
                words.append({
                    "word": word.get("word", ""),
                    "start": round(float(word.get("start", 0.0)), 3),
                    "end": round(float(word.get("end", 0.0)), 3),
                    "conf": round(float(word.get("conf", 0.0)), 3),
                })
    final = json.loads(recognizer.FinalResult())
    final_text = (final.get("text") or "").strip()
    if final_text:
        texts.append(final_text)
    for word in final.get("result", []) or []:
        words.append({
            "word": word.get("word", ""),
            "start": round(float(word.get("start", 0.0)), 3),
            "end": round(float(word.get("end", 0.0)), 3),
            "conf": round(float(word.get("conf", 0.0)), 3),
        })

    # 中文/英文：词之间不加空格；按停顿补标点（Vosk 小模型不输出标点）
    def is_cjk(text):
        return any("\u4e00" <= ch <= "\u9fff" for ch in text)

    for index, word in enumerate(words):
        nxt = words[index + 1] if index + 1 < len(words) else None
        gap = (nxt["start"] - word["end"]) if nxt else 0.0
        if is_cjk(word["word"]):
            if gap >= 0.5:
                word["punct"] = "。"
            elif gap >= 0.25:
                word["punct"] = "，"
        else:
            if gap >= 0.45:
                word["punct"] = "."

    # 按停顿/长度切句
    segments = []
    current = []
    for word in words:
        if not current:
            current = [word]
            continue
        gap = word["start"] - current[-1]["end"]
        span = word["end"] - current[0]["start"]
        if gap > args.pause or span > args.max_segment:
            segments.append(current)
            current = [word]
        else:
            current.append(word)
    if current:
        segments.append(current)

    segment_payload = []
    for group in segments:
        parts = []
        for word in group:
            parts.append(word["word"])
            if word.get("punct"):
                parts.append(word["punct"])
        text = "".join(parts).strip()
        if not text:
            continue
        segment_payload.append({
            "start": group[0]["start"],
            "end": group[-1]["end"],
            "text": text,
            "conf": round(sum(word["conf"] for word in group) / len(group), 3),
        })

    joined = "".join(segment["text"] for segment in segment_payload) if segment_payload else "".join(texts)
    payload = {
        "ok": True,
        "engine": "vosk",
        "text": joined,
        "words": words,
        "segments": segment_payload,
    }
    encoded = json.dumps(payload, ensure_ascii=False)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(encoded)
    print(encoded)


if __name__ == "__main__":
    main()
