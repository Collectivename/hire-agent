"""Named Modal secrets for owner provider keys.

The key arrives on stdin and is not printed. This file is imported by the
authenticated backend, not served as an HTTP route.
"""

import json
import sys


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.stdout.write(json.dumps({"ok": False}))
        return 1
    op = request.get("op")
    name = request.get("name") or ""
    entries = request.get("entries") or {}
    required = request.get("required_keys") or []
    if not isinstance(name, str) or not name.startswith("byok-"):
        sys.stdout.write(json.dumps({"ok": False}))
        return 1
    if not isinstance(entries, dict) or not isinstance(required, list):
        sys.stdout.write(json.dumps({"ok": False}))
        return 1
    if any(not isinstance(key, str) or not key for key in required):
        sys.stdout.write(json.dumps({"ok": False}))
        return 1
    try:
        import modal
    except ImportError:
        sys.stdout.write(json.dumps({"ok": False}))
        return 1
    try:
        if op == "create":
            modal.Secret.objects.create(name, entries)
            modal.Secret.from_name(name, required_keys=required)
        elif op == "update":
            modal.Secret.from_name(name, required_keys=required).update(entries)
        elif op == "delete":
            modal.Secret.objects.delete(name)
        elif op == "lookup":
            modal.Secret.from_name(name, required_keys=required)
        else:
            sys.stdout.write(json.dumps({"ok": False}))
            return 1
    except Exception:
        sys.stdout.write(json.dumps({"ok": False}))
        return 1
    sys.stdout.write(json.dumps({"ok": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
