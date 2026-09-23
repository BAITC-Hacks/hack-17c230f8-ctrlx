import sys


def use_utf8() -> None:
    # Windows consoles and pipes default to cp1252 and crash on Cyrillic; experts may use Windows.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
