"""render-round.sh against a fake Chromium. Linux only (timeout, stat -c): run on the Pi."""
import os
import subprocess
import time

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "avian", "render", "render-round.sh")


def fake_chromium(tmp_path, body):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "chromium-headless-shell"
    fake.write_text("#!/bin/sh\n" + body + "\n")
    fake.chmod(0o755)
    return {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "RENDER_TIMEOUT": "2"}


def test_hung_chromium_times_out_and_keeps_the_old_render(tmp_path):
    out = tmp_path / "birds-round.png"
    out.write_bytes(b"old render")
    env = fake_chromium(tmp_path, "sleep 60")
    start = time.monotonic()
    result = subprocess.run(["bash", SCRIPT, str(out)], env=env, capture_output=True, timeout=30)
    assert result.returncode != 0
    assert time.monotonic() - start < 10
    assert out.read_bytes() == b"old render"
