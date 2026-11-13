"""Drive an isolated real OpenCode CLI through a PTY; F8 observes draft state."""
import fcntl
import json
import os
import pathlib
import pty
import select
import struct
import subprocess
import sys
import termios
import time

binary, session_id, directory, observation = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
child = subprocess.Popen([binary, "--standalone", "--session", session_id, directory], stdin=slave, stdout=slave, stderr=slave, env=os.environ, cwd=directory, start_new_session=True)
os.close(slave)
output = bytearray()

def pump_until(predicate, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        if child.poll() is not None:
            raise AssertionError("CLI exited: " + output.decode(errors="replace")[-6000:])
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            chunk = os.read(master, 65536)
            output.extend(chunk)
            # Answer terminal capability probes; no keypresses are sent as prompts.
            if b"\x1b[6n" in chunk:
                os.write(master, b"\x1b[1;1R")
    observed = pathlib.Path(observation)
    raise AssertionError("Observed: " + (observed.read_text() if observed.exists() else "none") + "\nTimed out: " + output.decode(errors="replace")[-6000:])

def observe(expected):
    path = pathlib.Path(observation)
    path.unlink(missing_ok=True)
    os.write(master, b"\x1b[19~")
    pump_until(lambda: path.exists(), 10)
    actual = json.loads(path.read_text()).get("draft")
    assert actual == expected, (actual, expected)

def wait_placeholder(expected, contains=False):
    """Observe the real editor; incremental terminal frames need not repeat full text."""
    path = pathlib.Path(observation)
    path.unlink(missing_ok=True)
    os.write(master, b"\x1b[19~")

    def ready():
        if not path.exists():
            return False
        try:
            placeholder = json.loads(path.read_text()).get("placeholder", "")
        except json.JSONDecodeError:
            return False
        if isinstance(placeholder, str) and (expected in placeholder if contains else placeholder == expected):
            return True
        path.unlink(missing_ok=True)
        os.write(master, b"\x1b[19~")
        return False

    pump_until(ready)

try:
    if os.environ.get("PREDICTIONS_FEEDBACK_TEST") == "1":
        pump_until(lambda: pathlib.Path(observation + ".ready").exists() and b"Prediction settings are invalid" in output)
        assert b"Run the targeted tests." not in output
        os.write(master, b"\x1b[20~")
        pump_until(lambda: b"Prediction status snapshot" in output)
        assert b"PRIVATE" not in output
        os.write(master, b"\x1b[21~")
        observe("")
        output.clear()
        os.write(master, b"\x1b[20~")
        pump_until(lambda: b"Prediction status snapshot" in output)
        print(json.dumps({"statusReopened": True}))
    elif os.environ.get("PREDICTIONS_ESCALATION_TEST") == "1":
        pump_until(lambda: pathlib.Path(observation + ".ready").exists())
        wait_placeholder("Ask another model", contains=True)
        assert b"Run the targeted tests." not in output
        observe("")
        os.write(master, b"\t")
        observe("")
        os.write(master, b"\x1b[112;4u")
        wait_placeholder("Run the targeted tests.")
        observe("")
        os.write(master, b"\t")
        observe("Run the targeted tests.")
        print(json.dumps({"escalationValidated": True}))
    else:
        if os.environ.get("PREDICTIONS_MANUAL_TEST") == "1":
            pump_until(lambda: pathlib.Path(observation + ".ready").exists() and b"Fix the assertion." in output)
            observe("")
            assert b"Run the targeted tests." not in output
            # CSI-u distinguishes Alt+Shift+P from the legacy ESC P DCS introducer.
            os.write(master, b"\x1b[112;4u")
            observe("")
        pump_until(lambda: b"Run the targeted tests." in output)
        observe("")
        os.write(master, b"\t")
        observe("Run the targeted tests.")
        os.write(master, b"\x01\x0bmy own prompt\t")
        observe("my own prompt")
        print(json.dumps({"ghost": True, "tabDraft": "Run the targeted tests.", "typedInputPreserved": True}))
finally:
    child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
    os.close(master)
