#!/usr/bin/env python3
"""Fake chatgpt-imagegen.py stand-in for studio/test/*. Never touches the network.

Modes (via FAKE_IMAGEGEN_MODE env var):
  success (default) - writes a placeholder file at the -o path, exits 0.
  fail              - prints FAKE_IMAGEGEN_ERROR (or a default) to stderr, exits 1.
  hang              - sleeps 5s (long enough to exercise timeouts/concurrency in tests,
                       short enough that a test file never blocks for real), then exits 0
                       without writing an output file.
"""
import os
import sys
import time


def main():
    mode = os.environ.get("FAKE_IMAGEGEN_MODE", "success")
    args = sys.argv[1:]
    out_path = None
    for i, a in enumerate(args):
        if a == "-o" and i + 1 < len(args):
            out_path = args[i + 1]
            break

    if mode == "hang":
        time.sleep(5)
        return 0

    if mode == "fail":
        message = os.environ.get("FAKE_IMAGEGEN_ERROR", "fake failure for testing")
        print(message, file=sys.stderr)
        return 1

    if out_path:
        dirpath = os.path.dirname(out_path)
        if dirpath:
            os.makedirs(dirpath, exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(b"FAKE_PNG_FOR_TESTS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
