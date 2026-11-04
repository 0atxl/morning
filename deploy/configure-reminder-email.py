#!/usr/bin/env python3
"""One-time, interactive Gmail configuration on the Morning VM."""
import getpass
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile

if os.geteuid() != 0 or not sys.stdin.isatty():
    sys.exit("Run with sudo in an interactive SSH terminal on the Morning VM.")

directory = Path("/etc/morning")
if not (directory / "server.env").exists():
    sys.exit("Install Morning on this VM first.")
address = input("Gmail sending and receiving address: ").strip()
if not re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", address):
    sys.exit("Invalid email address.")
password = "".join(getpass.getpass("Gmail app password (hidden): ").split())
if not re.fullmatch(r"[A-Za-z0-9]{16}", password):
    sys.exit("Enter the dedicated 16-character app password.")
telegram_bot_token = input("Telegram Bot Token (optional, press Enter to skip): ").strip()
telegram_chat_id = input("Telegram Chat ID (optional, press Enter to skip): ").strip()

config = directory / "reminder-mail.env"
old = dict(line.split("=", 1) for line in config.read_text().splitlines() if "=" in line) if config.exists() else {}
if old.get("MORNING_GMAIL_ADDRESS", address).casefold() != address.casefold():
    sys.exit("This queue belongs to a different inbox. Rotate accounts manually.")
token = old.get("MORNING_REMINDER_OWNER_KEY") or secrets.token_urlsafe(32)
tg_lines = ""
if telegram_bot_token and telegram_chat_id:
    tg_lines = f"TELEGRAM_BOT_TOKEN={telegram_bot_token}\nTELEGRAM_CHAT_ID={telegram_chat_id}\n"
with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as temp:
    temp.write(f"MORNING_GMAIL_ADDRESS={address}\nMORNING_GMAIL_APP_PASSWORD={password}\nMORNING_REMINDER_OWNER_KEY={token}\n{tg_lines}")
    temp.flush()
    os.fsync(temp.fileno())
os.replace(temp.name, config)
subprocess.run(["systemctl", "restart", "morning-api.service"], check=True)
print("Open this private link once in your own browser. Keep it out of recordings and chat.")
print(f"https://morning.atuls.me/app#reminder-key={token}")
