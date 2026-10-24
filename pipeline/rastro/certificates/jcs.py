"""JSON Canonicalization Scheme (RFC 8785) for the value types Rastro bundles contain.

- objects: members sorted by the UTF-16 code units of their names, no whitespace
- strings: JSON escaping of RFC 8785 §3.2.2.2 (only `"`, `\\`, and control characters escaped;
  everything else, including non-ASCII, emitted as UTF-8)
- numbers: ECMAScript Number.prototype.toString (shortest round-trip; integral values without
  a fraction; exponent form only below 1e-6 or from 1e21, as `1e-7`, `1e+21`)
- NaN and infinities are rejected, as RFC 8785 requires

The SHA-256 commitment is computed over exactly these UTF-8 bytes. Any producer in any language
that follows RFC 8785 gets the same bytes, hence the same hash.
"""
import math

_ESC = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def canonicalize(value) -> bytes:
    return _ser(value).encode("utf-8")


def _ser(v) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        if abs(v) > 2**53:  # beyond IEEE-754 exact integers: JCS would lose precision
            raise ValueError(f"integer {v} exceeds 2^53; encode it as a string")
        return str(v)
    if isinstance(v, float):
        return _number(v)
    if isinstance(v, str):
        return _string(v)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(_ser(x) for x in v) + "]"
    if isinstance(v, dict):
        if not all(isinstance(k, str) for k in v):
            raise TypeError("object keys must be strings")
        keys = sorted(v, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(_string(k) + ":" + _ser(v[k]) for k in keys) + "}"
    raise TypeError(f"cannot canonicalize {type(v).__name__}")


def _string(s: str) -> str:
    out = []
    for ch in s:
        if ch in _ESC:
            out.append(_ESC[ch])
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def _number(x: float) -> str:
    if math.isnan(x) or math.isinf(x):
        raise ValueError("NaN and Infinity are not valid JSON numbers")
    if x == 0:
        return "0"
    if x.is_integer() and abs(x) < 1e21:
        return str(int(x))
    r = repr(x)  # shortest round-trip digits, like ECMAScript
    if "e" in r or "E" in r:
        mant, exp = r.lower().split("e")
        e = int(exp)
        if -7 < e < 21:  # ECMAScript prints these without an exponent
            return _plain(x)
        return f"{mant}e{'+' if e > 0 else '-'}{abs(e)}"
    if abs(x) < 1e-6:
        mant, e = _sci(r)
        return f"{mant}e-{abs(e)}"
    return r


def _plain(x: float) -> str:
    from decimal import Decimal
    return format(Decimal(repr(x)), "f")


def _sci(r: str):
    from decimal import Decimal
    d = Decimal(r).normalize()
    sign, digits, exp = d.as_tuple()
    m = "".join(map(str, digits))
    e = exp + len(m) - 1
    mant = m[0] + ("." + m[1:] if len(m) > 1 else "")
    return ("-" if sign else "") + mant, e
