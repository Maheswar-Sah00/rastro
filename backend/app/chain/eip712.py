"""EIP-712 hashing for HerdLedger certificates and secp256k1 signer recovery, in pure Python.

Matches HerdLedger.hashCertificate and OpenZeppelin ECDSA.recover: signatures with s in the upper
half of the curve order (malleable) or v outside {27, 28} are rejected.
"""
from app.chain.keccak import keccak256

DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
CERT_TYPE = ("Certificate(bytes32 lotId,bytes32 sink,bytes32[] gtaHashes,bytes32 shipment,uint32 head,uint8 verdict,"
             "bytes32 evidenceHash,uint64 issuedAt,uint64 expiresAt,uint16 policyVersion,uint256 nonce)")
CERT_FIELDS = [("lotId", "bytes32"), ("sink", "bytes32"), ("gtaHashes", "bytes32[]"), ("shipment", "bytes32"), ("head", "uint32"),
               ("verdict", "uint8"), ("evidenceHash", "bytes32"), ("issuedAt", "uint64"), ("expiresAt", "uint64"),
               ("policyVersion", "uint16"), ("nonce", "uint256")]
DOMAIN_NAME, DOMAIN_VERSION = "Rastro HerdLedger", "1"

# secp256k1
P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


class InvalidSignature(ValueError):
    pass


def _b32(h: str) -> bytes:
    b = bytes.fromhex(h[2:] if h.startswith("0x") else h)
    if len(b) != 32:
        raise ValueError("expected 32 bytes")
    return b


def _uint(v, bits: int) -> bytes:
    n = int(v)
    if not 0 <= n < 1 << bits:
        raise ValueError(f"uint{bits} out of range")
    return n.to_bytes(32, "big")


def domain_separator(chain_id: int, contract: str) -> bytes:
    addr = bytes.fromhex(contract[2:])
    return keccak256(keccak256(DOMAIN_TYPE.encode()) + keccak256(DOMAIN_NAME.encode()) + keccak256(DOMAIN_VERSION.encode())
                     + _uint(chain_id, 256) + bytes(12) + addr)


def struct_hash(cert: dict) -> bytes:
    enc = keccak256(CERT_TYPE.encode())
    for name, typ in CERT_FIELDS:
        v = cert[name]
        if typ == "bytes32":
            enc += _b32(v)
        elif typ == "bytes32[]":
            enc += keccak256(b"".join(_b32(x) for x in v))
        else:
            enc += _uint(v, int(typ[4:]))
    return keccak256(enc)


def digest(cert: dict, chain_id: int, contract: str) -> bytes:
    return keccak256(b"\x19\x01" + domain_separator(chain_id, contract) + struct_hash(cert))


# ---- secp256k1 (affine arithmetic; a handful of recoveries per request) -------------------------
def _add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0:
        return None
    lam = ((3 * a[0] * a[0]) * pow(2 * a[1], -1, P) if a == b else (b[1] - a[1]) * pow(b[0] - a[0], -1, P)) % P
    x = (lam * lam - a[0] - b[0]) % P
    return x, (lam * (a[0] - x) - a[1]) % P


def _mul(k, pt):
    out = None
    while k:
        if k & 1:
            out = _add(out, pt)
        pt = _add(pt, pt)
        k >>= 1
    return out


def recover(msg_hash: bytes, signature: str) -> str:
    sig = bytes.fromhex(signature[2:] if signature.startswith("0x") else signature)
    if len(sig) != 65:
        raise InvalidSignature("signature must be 65 bytes")
    r, s, v = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:64], "big"), sig[64]
    if v not in (27, 28):
        raise InvalidSignature(f"invalid v {v}")
    if not (0 < r < N and 0 < s <= N // 2):
        raise InvalidSignature("r or s out of range (high-s signatures are malleable and rejected)")
    y2 = (pow(r, 3, P) + 7) % P
    y = pow(y2, (P + 1) // 4, P)
    if y * y % P != y2:
        raise InvalidSignature("r is not on the curve")
    if y % 2 != v - 27:
        y = P - y
    e = int.from_bytes(msg_hash, "big")
    rinv = pow(r, -1, N)
    q = _add(_mul(s * rinv % N, (r, y)), _mul((-e * rinv) % N, G))
    if q is None:
        raise InvalidSignature("recovered the point at infinity")
    pub = q[0].to_bytes(32, "big") + q[1].to_bytes(32, "big")
    return "0x" + keccak256(pub)[12:].hex()
