"""Install the pinned upstream binary locally, without running an installer."""

import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import tarfile
import urllib.request
import zipfile


VERSION = "1.1.18"
ASSETS = {
    "Linux": ("moli-x86_64-unknown-linux-gnu.tar.gz", "59715fbdb2b016bb9136e1edb59a2a195c0f98459fd06739e17edc62da6a48b1"),
    "Windows": ("moli-x86_64-pc-windows-msvc.zip", "6a7b8a53c6de2392b53b881e98a9060ce4e49ae7d1f7d84d0dc3bda8fe4ef71a"),
}


def license_path(member):
    if any(character in member for character in ("\\", ":", "\x00")) or PurePosixPath(member).is_absolute() or ".." in PurePosixPath(member).parts:
        return None
    parts = PurePosixPath(member).parts[1:]
    if not parts or any(part in {"", ".", ".."} for part in parts):
        return None
    if parts[0] not in {"LICENSE-APACHE", "LICENSE-MIT", "license-metadata.json", "licenses", "VERSION"}:
        return None
    return Path("moli-licenses", *parts)


def save_license(destination, name, source, size):
    relative = license_path(name)
    if relative is None:
        return
    if size > 4 * 1024 * 1024:
        raise RuntimeError("Unexpected oversized release license material.")
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as output:
        shutil.copyfileobj(source, output)


def install(destination: Path) -> Path:
    if platform.machine().lower() not in {"amd64", "x86_64"} or platform.system() not in ASSETS:
        raise SystemExit("Only the pinned Linux/Windows x64 assets are supported.")
    asset, expected = ASSETS[platform.system()]
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / (asset + ".download")
    digest = hashlib.sha256()
    request = urllib.request.Request(
        f"https://github.com/lexmount/moli/releases/download/v{VERSION}/{asset}",
        headers={"User-Agent": "Rivule-regional-worker-installer"},
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response, archive.open("wb") as output:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 70 * 1024 * 1024:
                    raise RuntimeError("Release asset exceeds the download limit.")
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != expected:
            raise RuntimeError("Release asset integrity check failed.")
        name = "moli.exe" if platform.system() == "Windows" else "moli"
        target = destination / name
        if asset.endswith(".zip"):
            with zipfile.ZipFile(archive) as bundle:
                members = [member for member in bundle.infolist() if Path(member.filename).name == name]
                if len(members) != 1 or members[0].file_size > 200 * 1024 * 1024:
                    raise RuntimeError("Unexpected binary in release archive.")
                with bundle.open(members[0]) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                for member in bundle.infolist():
                    if not member.is_dir() and license_path(member.filename):
                        with bundle.open(member) as source:
                            save_license(destination, member.filename, source, member.file_size)
        else:
            with tarfile.open(archive, "r:gz") as bundle:
                members = [member for member in bundle.getmembers() if Path(member.name).name == name and member.isfile()]
                if len(members) != 1 or members[0].size > 200 * 1024 * 1024:
                    raise RuntimeError("Unexpected binary in release archive.")
                with bundle.extractfile(members[0]) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                for member in bundle.getmembers():
                    if member.isfile() and license_path(member.name):
                        with bundle.extractfile(member) as source:
                            save_license(destination, member.name, source, member.size)
        os.chmod(target, 0o755)
        return target.resolve()
    finally:
        archive.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, default=Path(__file__).parent / ".runtime")
    print(install(parser.parse_args().destination))
