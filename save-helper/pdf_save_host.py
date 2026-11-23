"""Native messaging host for PDF Citation Hover: writes a PDF to disk.

Browsers don't let extensions overwrite files, so the extension sends the
PDF here. Protocol (JSON messages, 4-byte little-endian length prefix):
  {"cmd": "begin", "path": "C:\\...\\a.pdf", "saveAs": false, "suggestedName": "a.pdf"}
  {"cmd": "chunk", "data": "<base64>"}   (repeated)
  {"cmd": "end"}
Reply: {"ok": true, "path": ...} | {"cancelled": true} | {"ok": false, "error": ...}

Safety: only .pdf files are written, content must start with %PDF, and
"save" (no dialog) only overwrites a file that already exists.
"""
import base64
import json
import os
import struct
import sys


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def ask_save_path(initial_path, suggested_name):
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    if initial_path:
        initial_dir, initial_file = os.path.split(initial_path)
    else:
        initial_dir = os.path.join(os.path.expanduser("~"), "Downloads")
        initial_file = suggested_name or "document.pdf"
    path = filedialog.asksaveasfilename(
        parent=root,
        title="Save as",
        initialdir=initial_dir,
        initialfile=initial_file,
        defaultextension=".pdf",
        filetypes=[("PDF document", "*.pdf")],
    )
    root.destroy()
    return path or None


def main():
    begin = read_message()
    if not begin or begin.get("cmd") != "begin":
        return send({"ok": False, "error": "Unexpected message"})

    path = begin.get("path") or ""
    if begin.get("saveAs"):
        path = ask_save_path(path, begin.get("suggestedName"))
        if not path:
            return send({"cancelled": True})
    else:
        if not os.path.isabs(path) or not os.path.isfile(path):
            return send({"ok": False, "error": f"Original file not found: {path}"})

    path = os.path.abspath(path)
    if not path.lower().endswith(".pdf"):
        return send({"ok": False, "error": "Only .pdf files can be saved"})

    tmp = path + ".saving.tmp"
    try:
        with open(tmp, "wb") as f:
            first = True
            while True:
                msg = read_message()
                if msg is None:
                    raise IOError("Connection closed before the file was complete")
                if msg.get("cmd") == "end":
                    break
                data = base64.b64decode(msg.get("data", ""))
                if first and not data.startswith(b"%PDF"):
                    raise ValueError("Data is not a PDF")
                first = False
                f.write(data)
        replace_with_retry(tmp, path)
        send({"ok": True, "path": path})
    except Exception as e:  # report every failure to the viewer
        try:
            os.remove(tmp)
        except OSError:
            pass
        msg = str(e)
        if isinstance(e, PermissionError):
            msg = f"Can't write {path} (it may be open in another program, or read-only). {e}"
        send({"ok": False, "error": msg})


def replace_with_retry(src, dst):
    """os.replace, retried briefly: antivirus or indexers often lock a freshly
    written file for a moment on Windows."""
    import time

    for attempt in range(20):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == 19:
                break
            time.sleep(0.15)
    # Last resort: overwrite the original's contents in place.
    with open(src, "rb") as s, open(dst, "r+b") as d:
        while True:
            block = s.read(1 << 20)
            if not block:
                break
            d.write(block)
        d.truncate()
    os.remove(src)


if __name__ == "__main__":
    main()
