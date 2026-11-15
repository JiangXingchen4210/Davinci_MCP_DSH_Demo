#!/usr/bin/env python3
"""QQ 邮箱读取脚本（IMAP + 授权码，凭据存 macOS 钥匙串，不写明文）。

用法：
  1) 首次配置（授权码不要发到聊天里，直接在本机终端输入）：
       python3 scripts/mail_fetch.py setup
  2) 列出最近邮件：
       python3 scripts/mail_fetch.py list --limit 10
       python3 scripts/mail_fetch.py list --unread
  3) 读某一封（uid 或序号）：
       python3 scripts/mail_fetch.py read 12345        # uid
       python3 scripts/mail_fetch.py read 1 --index    # 列表里第 1 封（最新）
  4) 按发件人/主题过滤 + 保存正文：
       python3 scripts/mail_fetch.py list --from dji --json
       python3 scripts/mail_fetch.py read 1 --index --out /tmp/mail.txt

凭据（IMAP 用户名/授权码）保存在钥匙串：
  service = davinci-mail
  账号名  = 邮箱地址
可用环境变量覆盖：MAIL_USER、MAIL_AUTH_CODE（不推荐，容易进 shell 历史）。
"""
from __future__ import annotations

import argparse
import email
import email.header
import email.utils
import getpass
import html
import imaplib
import json
import os
import re
import subprocess
import sys
from email.message import Message
from typing import Iterable

IMAP_HOST = "imap.qq.com"
IMAP_PORT = 993
KEYCHAIN_SERVICE = "davinci-mail"


def keychain_get(account: str) -> str | None:
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
            capture_output=True, text=True, timeout=10, check=False,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def keychain_set(account: str, secret: str) -> None:
    subprocess.run(
        ["security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", secret],
        check=True,
    )


def load_credentials() -> tuple[str, str]:
    user = os.environ.get("MAIL_USER") or keychain_get("__user__") or ""
    code = os.environ.get("MAIL_AUTH_CODE") or (keychain_get(user) if user else None)
    if not user or not code:
        sys.exit(
            "缺少凭据：先运行 `python3 scripts/mail_fetch.py setup`（授权码在本机输入，不会上传）。"
        )
    return user, code


def setup() -> None:
    user = input("邮箱地址（如 2504836725@qq.com）：").strip()
    if not user:
        sys.exit("邮箱不能为空")
    code = getpass.getpass("QQ 邮箱授权码（输入时不显示）：").strip()
    if not code:
        sys.exit("授权码不能为空")
    keychain_set("__user__", user)
    keychain_set(user, code)
    print(f"已保存到钥匙串（service={KEYCHAIN_SERVICE}, account={user}）")


def connect() -> imaplib.IMAP4_SSL:
    user, code = load_credentials()
    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    conn.login(user, code)
    return conn


def decode_header_value(value: str | None) -> str:
    if not value:
        return ""
    parts = []
    for text, charset in email.header.decode_header(value):
        if isinstance(text, bytes):
            try:
                parts.append(text.decode(charset or "utf-8", errors="replace"))
            except Exception:
                parts.append(text.decode("utf-8", errors="replace"))
        else:
            parts.append(text)
    return "".join(parts)


def strip_html(raw: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", raw)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</p>", "\n\n", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def body_of(msg: Message) -> str:
    if msg.is_multipart():
        plain, html_part = None, None
        for part in msg.walk():
            ctype = part.get_content_type()
            if part.get_content_maintype() == "multipart":
                continue
            if ctype == "text/plain" and plain is None:
                plain = part
            elif ctype == "text/html" and html_part is None:
                html_part = part
        target = plain or html_part
        if target is None:
            return ""
        payload = target.get_payload(decode=True) or b""
        charset = target.get_content_charset() or "utf-8"
        text = payload.decode(charset, errors="replace")
        return text if target is html_part else strip_html(text) if not plain else text
    payload = msg.get_payload(decode=True) or b""
    charset = msg.get_content_charset() or "utf-8"
    text = payload.decode(charset, errors="replace")
    return strip_html(text) if msg.get_content_type() == "text/html" else text


def summarize(conn, uid: bytes, index: int) -> dict:
    status, data = conn.uid("fetch", uid, "(RFC822.HEADER)")
    msg = email.message_from_bytes(data[0][1]) if status == "OK" else Message()
    return {
        "index": index,
        "uid": uid.decode() if isinstance(uid, bytes) else str(uid),
        "from": decode_header_value(msg.get("From")),
        "to": decode_header_value(msg.get("To")),
        "subject": decode_header_value(msg.get("Subject")),
        "date": decode_header_value(msg.get("Date")),
        "message_id": (msg.get("Message-ID") or "").strip(),
    }


def cmd_list(args) -> None:
    conn = connect()
    conn.select("INBOX", readonly=True)
    criterion = "UNSEEN" if args.unread else "ALL"
    status, data = conn.uid("search", None, criterion)
    if status != "OK":
        sys.exit("搜索失败")
    uids = data[0].split()
    uids = list(reversed(uids))[: args.limit]
    items = [summarize(conn, uid, i + 1) for i, uid in enumerate(uids)]
    if args.from_:
        needle = args.from_.lower()
        items = [it for it in items if needle in it["from"].lower() or needle in it["subject"].lower()]
    if args.json:
        print(json.dumps(items, ensure_ascii=False, indent=2))
    else:
        for it in items:
            print(f"[{it['index']}] uid={it['uid']} | {it['date']} | {it['from']} | {it['subject']}")
    conn.logout()


def fetch_message(conn, uid: str | None, index: int | None) -> tuple[Message, dict]:
    conn.select("INBOX", readonly=True)
    if uid is None:
        status, data = conn.uid("search", None, "ALL")
        uids = data[0].split()
        if not uids:
            sys.exit("收件箱为空")
        uid = list(reversed(uids))[max(0, (index or 1) - 1)].decode()
    status, data = conn.uid("fetch", uid, "(RFC822)")
    if status != "OK" or not data or not isinstance(data[0], tuple):
        sys.exit(f"读取失败：uid={uid}")
    msg = email.message_from_bytes(data[0][1])
    meta = {
        "uid": uid,
        "from": decode_header_value(msg.get("From")),
        "to": decode_header_value(msg.get("To")),
        "subject": decode_header_value(msg.get("Subject")),
        "date": decode_header_value(msg.get("Date")),
    }
    return msg, meta


def cmd_read(args) -> None:
    conn = connect()
    uids: list[str] = []
    if args.uids:
        uids = [u.strip() for u in str(args.uids).split(",") if u.strip()]
    elif isinstance(args.uid, list) and args.uid:
        uids = [str(u) for u in args.uid]
    if len(uids) > 1:
        out_all = []
        for uid in uids:
            msg, meta = fetch_message(conn, uid, None)
            text = body_of(msg)
            out_all.append({"meta": meta, "body": text})
            if not args.json:
                print(f"===== uid={uid} | {meta['date']} | {meta['from']}")
                print("主题：" + meta["subject"])
                print(text[:1500])
                print()
        if args.json:
            print(json.dumps(out_all, ensure_ascii=False, indent=2))
        if args.out:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(out_all, ensure_ascii=False, indent=2))
            print(f"saved: {args.out}")
        conn.logout()
        return
    msg, meta = fetch_message(conn, uids[0] if uids else args.uid, args.index)
    text = body_of(msg)
    out = {"meta": meta, "body": text}
    if args.json:
        payload = json.dumps(out, ensure_ascii=False, indent=2)
    else:
        payload = f"发件人：{meta['from']}\n主题：{meta['subject']}\n时间：{meta['date']}\n\n{text}"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(payload)
        print(f"saved: {args.out}")
    else:
        print(payload)
    conn.logout()


def main(argv: Iterable[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="QQ 邮箱读取（IMAP）")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup", help="保存邮箱地址与授权码到钥匙串")
    p_list = sub.add_parser("list", help="列出最近邮件")
    p_list.add_argument("--limit", type=int, default=10)
    p_list.add_argument("--unread", action="store_true")
    p_list.add_argument("--from", dest="from_", default=None)
    p_list.add_argument("--json", action="store_true")
    p_read = sub.add_parser("read", help="读取一封或多封邮件")
    p_read.add_argument("uid", nargs="*", default=None, help="一个或多个 uid（空格分隔）")
    p_read.add_argument("--uids", default=None, help="逗号分隔的 uid 列表，如 2823,2825")
    p_read.add_argument("--index", type=int, default=1, help="按列表序号读（1=最新）")
    p_read.add_argument("--json", action="store_true")
    p_read.add_argument("--out", default=None)
    args = parser.parse_args(list(argv) if argv is not None else None)
    if args.cmd == "setup":
        setup()
    elif args.cmd == "list":
        cmd_list(args)
    elif args.cmd == "read":
        cmd_read(args)


if __name__ == "__main__":
    main()
