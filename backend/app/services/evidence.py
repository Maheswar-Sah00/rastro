"""Evidence files are content-addressed canonical JSON: the file name is the SHA-256 of its bytes."""
import hashlib
from pathlib import Path


def check(path: Path, expected_hex: str) -> tuple[bool, bool | None]:
    """(file present, SHA-256 of its bytes equals the expected hash; None when absent)."""
    if not path.is_file():
        return False, None
    return True, hashlib.sha256(path.read_bytes()).hexdigest() == expected_hex.removeprefix("0x")
