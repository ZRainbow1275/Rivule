#!/usr/bin/env python3
"""Restore the verified Nov 15 source into a NEW directory and integrate reviewed public fixes."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
PUBLIC_COMMIT = "cf7c77fff10906c1a509a5e9db681ba2a13056de"
ARCHIVE_SHA256 = "1a689d45387568d1a72f3edd1143035701f43aa1ecfba76799dff1b0830d0a99"
PATCHES = {
    "01-showcase-provenance.patch": "18992aa16dcfba2606423370bb722423ea239fc9124fb3d4fd42d5a8fcc5628b",
    "02-preserve-private-config.patch": "bd8b45a820a12ea48fbe34142d943efee58add60bc955376d5a3abfbd91b3775",
    "03-qq-ordinary-text.patch": "7f4c07c23130a6521ec6a573f23ebf1d4b6cce92cc4f78613318c11a48ee8e4a",
    "10-dashboard-text-boundaries.patch": "a2e649e6835eb82691f609d25ee89ac92aa6024c35154691bc0d786f0d410a33",
}
def sha(data):
    return hashlib.sha256(data).hexdigest()

def one(text, before, after):
    if text.count(before) != 1:
        raise ValueError("The expected code anchor is absent or ambiguous.")
    return text.replace(before, after)

def section(text, start, end):
    if text.count(start) != 1 or text.count(end) != 1:
        raise ValueError("The expected code section is absent or ambiguous.")
    head = text.index(start)
    return text[head:text.index(end, head)]

def restore(archive, work):
    if archive.stat().st_size != 14712481 or sha(archive.read_bytes()) != ARCHIVE_SHA256:
        raise ValueError("Not the verified 2026-11-15 archive; nothing was applied.")
    with tarfile.open(archive, "r:gz") as tar:
        pins = json.load(tar.extractfile("SOURCE-PINS.json"))
        files = [m for m in tar if m.name.startswith("source/")]
        if len(pins) != 312 or len(files) != len(pins) or {m.name[7:] for m in files} != set(pins):
            raise ValueError("Source inventory differs from the recorded archive.")
        for member in files:
            name = member.name[7:]
            rel = PurePosixPath(name)
            if not member.isfile() or rel.is_absolute() or any(part in (".", "..", ".git") for part in rel.parts) or "\\" in name:
                raise ValueError("Unexpected archive member.")
            buf = tar.extractfile(member).read()
            if sha(buf) != pins[name]:
                raise ValueError("Source checksum mismatch: " + name)
            dst = work / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(buf)
    return pins

def environment():
    # Ignore surrounding worktrees, alternate indexes and user git configuration.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    return {**env, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0"}

def git(cwd, *args):
    return subprocess.check_output(["git", *args], cwd=cwd, env=environment(), stderr=subprocess.PIPE)

PUBLIC_DONORS = {
    "tests/qq-bridge-responses.test.mjs": "e3b0ad1ec2b46c06032576ed3b42a2b8433d98c7ff6bc6a7a3614b8d2b61e1f4",
    "src/owner/notification-policy.mjs": "7419be772a95081af2168787d1303f4ba51e04ae9a74e3c450dd79e57ab66b28",
}

def public_bytes(root, name):
    expected = PUBLIC_DONORS[name]
    candidate = root / name
    if candidate.is_file() and not candidate.is_symlink() and sha(candidate.read_bytes()) == expected:
        return candidate.read_bytes()
    data = git(root, "show", PUBLIC_COMMIT + ":" + name)
    if sha(data) != expected:
        raise ValueError("Different public donor: " + name)
    return data

def integrate(work, donor):
    git(work, "init", "--quiet")
    for name, expected in PATCHES.items():
        patch = HERE / "public-patches" / name
        if sha(patch.read_bytes()) != expected:
            raise ValueError("Public patch checksum mismatch: " + name)
        git(work, "apply", "--check", str(patch))
        git(work, "apply", str(patch))

    # Port notices without replacing the cumulative branch's existing argument validation,
    # registered reply context, or output composition.
    path = work / "src/owner/notification-policy.mjs"
    text = path.read_text()
    origin = public_bytes(donor, "src/owner/notification-policy.mjs").decode()
    head = "export function formatQQNotification("
    text = one(text, head, section(origin, "const QQ_TEXT_LIMIT", head) + head)
    text = one(text, section(text, "  const pending =", "  const states ="),
               section(origin, "  const deadline =", "  const states ="))
    text = one(text, section(text, "  const label =", "  const brand ="),
               section(origin, "  const label =", "  const brand ="))
    tail = text.index("  let content = compose(event.summary);")
    old_tail = text[tail:text.index("\n}", tail)]
    start = origin.index("  const full = compose(event.summary);")
    text = one(text, old_tail, origin[start:origin.index("\n}", start)])
    path.write_text(text)

    path = work / "src/owner/qq-integration.mjs"
    text = path.read_text()
    name_import = 'import { sourceBrand } from "./brand-identity.mjs";\n'
    if name_import.strip() in text:
        raise ValueError("Unexpected duplicate brand import.")
    text = one(text, "source.name ?? source.source_id} · PA 回复",
               "sourceBrand(source).name} · PA 回复")
    path.write_text(name_import + text)

    path = work / "src/owner/presentation.mjs"
    text = one(path.read_text(), "queued:'排队中',retry_wait:'等待重试'",
               "queued:'排队中（尚未发送）',retry_wait:'等待重试（尚未确认送达）'")
    path.write_text(text)
    path = work / "tests/dashboard-presentation.test.mjs"
    old_caption = r"Discord 投递 · 排队中 \/ 等待重试 \/ 结果未知"
    new_caption = r"Discord 投递 · 排队中（尚未发送） \/ 等待重试（尚未确认送达） \/ 结果未知"
    path.write_text(one(path.read_text(), old_caption, new_caption))
    # Both delivery states are already recognized by the cumulative read model.
    readmodel = (work / "src/owner/dashboard-activity.mjs").read_text()
    if "'pending','queued','retry_wait','sending'" not in readmodel:
        raise ValueError("Unexpected delivery-state vocabulary.")

    path = work / "tests/qq-bridge-responses.test.mjs"
    text = one(path.read_text(), "function fixture(t){", "function fixture(t, identity={}){")
    text = one(text, "allowed_hosts:[]},ref=", "allowed_hosts:[],...identity},ref=")
    public_tests = public_bytes(donor, "tests/qq-bridge-responses.test.mjs").decode()
    anchor = "for (const [label,identity,expected] of ["
    if public_tests.count(anchor) != 1 or anchor in text:
        raise ValueError("Unexpected response identity fixture.")
    path.write_text(text.rstrip() + "\n\n" + public_tests[public_tests.index(anchor):])

    shutil.rmtree(work / ".git")

def execute(archive, dest):
    dest = dest.absolute()
    if dest.exists() or dest.is_symlink() or not dest.parent.is_dir():
        raise ValueError("Choose a new output directory within an existing parent.")
    # Refuse before creating any output if the checkout does not contain the public donor.
    repo = HERE.parent.parent
    for name in PUBLIC_DONORS:
        public_bytes(repo, name)
    with tempfile.TemporaryDirectory(prefix=".rivule-restore-", dir=dest.parent) as tmp:
        work = Path(tmp) / "source"
        work.mkdir()
        original = restore(archive, work)
        integrate(work, repo)
        output = {p.relative_to(work).as_posix(): sha(p.read_bytes()) for p in work.rglob("*") if p.is_file()}
        expected = json.loads((HERE / "changed-sha256.json").read_text())
        if set(original) - set(output) or {p: v for p, v in output.items() if original.get(p) != v} != expected:
            raise ValueError("Restored changes differ from the approved manifest.")
        # Exclusive reservation prevents replacing anything created while validation ran.
        dest.mkdir(mode=0o700)
        for f in work.iterdir():
            f.rename(dest / f.name)
    print(f"Verified {len(original)} source files; restored {len(output)} files, {len(expected)} changed or added.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help="The privately held, verified Nov 15 .tar.gz")
    parser.add_argument("output", type=Path, help="New directory; never an existing checkout")
    args = parser.parse_args()
    execute(args.archive, args.output)

