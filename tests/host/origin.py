"""Observe native CLI origin without submitting input or exposing credentials."""
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
import signal

binary, session_id, directory, observation, args = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
child = subprocess.Popen(
    [binary, *json.loads(args), "--session", session_id, directory],
    stdin=slave, stdout=slave, stderr=slave, env=os.environ, cwd=directory,
    start_new_session=True,
)
os.close(slave)
output = bytearray()
path = pathlib.Path(observation)
try:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if path.exists():
            try:
                value = json.loads(path.read_text())
            except json.JSONDecodeError:
                continue
            assert value["clientPid"] == child.pid
            if os.environ.get("PREDICTIONS_ORIGIN_WATCH"):
                assert value["serverParentPid"] == child.pid
                assert value["privateServerCommand"] is True
                parent = subprocess.check_output(["/bin/ps", "-p", str(value["serverPid"]), "-o", "ppid="], text=True)
                assert int(parent.strip()) == child.pid
                os.kill(value["serverPid"], signal.SIGTERM)
                after = pathlib.Path(observation + ".after")
                failure_deadline = time.monotonic() + 6
                while time.monotonic() < failure_deadline:
                    if child.poll() is not None:
                        value["afterFailure"] = {"clientExited": True}
                        break
                    if after.exists():
                        try:
                            latest = json.loads(after.read_text())
                            if not latest["serverAvailable"]:
                                value["afterFailure"] = latest
                                break
                        except json.JSONDecodeError:
                            pass
                    ready, _, _ = select.select([master], [], [], 0.05)
                    if ready:
                        try:
                            os.read(master, 65536)
                        except OSError:
                            pass
                else:
                    raise AssertionError("Private-server failure did not produce an unavailable observation")
            print(json.dumps({"started": True, **value}))
            break
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                chunk = b""
            output.extend(chunk)
            if b"\x1b[6n" in chunk:
                os.write(master, b"\x1b[1;1R")
        if child.poll() is not None:
            print(json.dumps({
                "started": False,
                "exitCode": child.returncode,
                "conflictingFlagsRejected": b"--server and --standalone cannot be combined" in output,
            }))
            break
    else:
        raise AssertionError("Native CLI did not produce an origin observation before the deadline")
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=4)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
