"""RFC 8785 JSON Canonicalization Scheme (JCS).

Keys sorted by Unicode code point, no whitespace, UTF-8, no BOM.
Null values are preserved (pure RFC 8785; no null stripping).
"""

import json
import math
from typing import Any


def canonicalize(obj: Any) -> bytes:
    return _serialize_value(obj).encode("utf-8")


def _serialize_value(val: Any) -> str:
    if val is None:
        return "null"
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, int):
        return str(val)
    if isinstance(val, float):
        return _serialize_number(val)
    if isinstance(val, str):
        return _json_string(val)
    if isinstance(val, list):
        return "[" + ",".join(_serialize_value(v) for v in val) + "]"
    if isinstance(val, dict):
        return _serialize_object(val)
    raise TypeError(f"canonicalize: unsupported type {type(val).__name__}")


def _serialize_object(obj: dict[str, Any]) -> str:
    keys = sorted(obj.keys())
    pairs = (f"{_json_string(k)}:{_serialize_value(obj[k])}" for k in keys)
    return "{" + ",".join(pairs) + "}"


def _serialize_number(n: float) -> str:
    if not math.isfinite(n):
        raise ValueError(f"canonicalize: non-finite number {n}")
    if n.is_integer() and abs(n) < 1e21:
        return str(int(n))
    return repr(n)


def _json_string(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)
