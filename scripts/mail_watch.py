#!/usr/bin/env python3
"""轮询 QQ 邮箱，发现新邮件时打印摘要并退出（供后台监听使用）。

用法：
  python3 scripts/mail_watch.py --interval 30 --timeout 1800
  python3 scripts/mail_watch.py --init          # 只记录当前最新 uid，不输出

状态文件：~/.dsh/mail_watch_state.json（记录 seen uid）
退出码：0 = 发现新邮件（stdout 打印摘要）；2 = 超时无新邮件；1 = 出错
"""
from __future__ import annotations

import argparse
import email
import email.header
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mail_fetch import connect  # noqa: E402

STATE = os.path.expanduser("~/.dsh/mail_watch_state.json")


def decode(value: str | None) -> str:
    if not value:
        return ""
    parts = []
    for text, charset in email.header.decode_header(value):
        if isinstance(text, bytes):
            parts.append(text.decode(charset or "utf-8", errors="replace"))
        else:
            parts.append(text)
    return "".join(parts)


def load_seen() -> int:
    try:
        with open(STATE, encoding="utf-8") as fh:
            return int(json.load(fh).get("seen_uid", 0))
    except Exception:
        return 0


def save_seen(uid: int) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as fh:
        json.dump({"seen_uid": uid, "at": int(time.time())}, fh)


def max_uid(conn) -> int:
    conn.select("INBOX", readonly=True)
    status, data = conn.uid("search", None, "ALL")
    uids = [int(u) for u in (data[0].split() if status == "OK" else [])]
    return max(uids) if uids else 0


def summarize(conn, uid: bytes) -> str:
    status, data = conn.uid("fetch", uid, "(RFC822.HEADER)")
    if status != "OK":
        return f"uid={uid.decode()} (读取失败)"
    msg = email.message_from_bytes(data[0][1])
    return f"uid={uid.decode()} | {decode(msg.get('Date'))} | {decode(msg.get('From'))} | {decode(msg.get('Subject'))}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--timeout", type=int, default=1800, help="总监听秒数（默认 30 分钟）")
    parser.add_argument("--init", action="store_true", help="只记录当前最新 uid")
    args = parser.parse_args()

    conn = connect()
    if args.init:
        uid = max_uid(conn)
        save_seen(uid)
        print(f"initialized seen_uid={uid}")
        conn.logout()
        return 0

    seen = load_seen()
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        try:
            conn.select("INBOX", readonly=True)
            status, data = conn.uid("search", None, "ALL")
            uids = [int(u) for u in (data[0].split() if status == "OK" else [])]
            new = [u for u in uids if u > seen]
            if new:
                print(f"NEW MAIL: {len(new)} 封")
                for u in sorted(new)[:10]:
                    print(" -", summarize(conn, str(u).encode()))
                save_seen(max(uids))
                conn.logout()
                return 0
        except Exception as exc:  # 网络抖动时继续轮询
            print(f"poll error: {exc}", file=sys.stderr)
        time.sleep(max(5, args.interval))
    conn.logout()
    return 2


if __name__ == "__main__":
    sys.exit(main())
