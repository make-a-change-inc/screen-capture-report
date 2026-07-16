from __future__ import annotations

import os
import platform
from pathlib import Path
from typing import Protocol

from cryptography.fernet import Fernet, InvalidToken


class KeyProtector(Protocol):
    def protect(self, value: bytes) -> bytes: ...

    def unprotect(self, value: bytes) -> bytes: ...


class WindowsDPAPIProtector:
    """Protects key material for the current Windows user with DPAPI."""

    def __init__(self) -> None:
        if platform.system() != "Windows":
            raise RuntimeError("Windows DPAPI is only available on Windows")
        try:
            import win32crypt
        except ImportError as exc:  # pragma: no cover - Windows packaging path
            raise RuntimeError("pywin32 is required for DPAPI protection") from exc
        self._win32crypt = win32crypt

    def protect(self, value: bytes) -> bytes:
        return self._win32crypt.CryptProtectData(
            value,
            "ScreenCaptureReport data key",
            None,
            None,
            None,
            0,
        )[1]

    def unprotect(self, value: bytes) -> bytes:
        return self._win32crypt.CryptUnprotectData(value, None, None, None, 0)[1]


class PassthroughKeyProtector:
    """Test-only protector used with isolated temporary directories."""

    def protect(self, value: bytes) -> bytes:
        return value

    def unprotect(self, value: bytes) -> bytes:
        return value


class EncryptionService:
    def __init__(self, fernet: Fernet):
        self._fernet = fernet

    @classmethod
    def from_key_file(
        cls,
        key_path: Path,
        protector: KeyProtector | None = None,
    ) -> EncryptionService:
        protector = protector or WindowsDPAPIProtector()
        key_path.parent.mkdir(parents=True, exist_ok=True)
        if key_path.exists():
            key = protector.unprotect(key_path.read_bytes())
        else:
            key = Fernet.generate_key()
            temporary = key_path.with_suffix(".tmp")
            temporary.write_bytes(protector.protect(key))
            os.replace(temporary, key_path)
        return cls(Fernet(key))

    @classmethod
    def for_tests(cls) -> EncryptionService:
        return cls(Fernet(Fernet.generate_key()))

    def encrypt_bytes(self, value: bytes) -> bytes:
        return self._fernet.encrypt(value)

    def decrypt_bytes(self, value: bytes) -> bytes:
        try:
            return self._fernet.decrypt(value)
        except InvalidToken as exc:
            raise ValueError("Encrypted payload authentication failed") from exc

    def encrypt_text(self, value: str | None) -> bytes | None:
        if value is None:
            return None
        return self.encrypt_bytes(value.encode("utf-8"))

    def decrypt_text(self, value: bytes | None) -> str | None:
        if value is None:
            return None
        return self.decrypt_bytes(value).decode("utf-8")


class EncryptedFileStore:
    def __init__(self, root: Path, encryption: EncryptionService):
        self.root = root
        self.encryption = encryption
        self.root.mkdir(parents=True, exist_ok=True)

    def write(self, relative_path: str, payload: bytes) -> Path:
        target = self.root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_bytes(self.encryption.encrypt_bytes(payload))
        os.replace(temporary, target)
        return target

    def read(self, relative_path: str) -> bytes:
        return self.encryption.decrypt_bytes((self.root / relative_path).read_bytes())

    def delete(self, relative_path: str) -> bool:
        target = self.root / relative_path
        if not target.exists():
            return False
        target.unlink()
        return True

    def exists(self, relative_path: str) -> bool:
        return (self.root / relative_path).exists()
