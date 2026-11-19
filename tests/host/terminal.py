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
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, int(os.environ.get("PREDICTIONS_PTY_COLS", "100")), 0, 0))
launch = [] if os.environ.get("PREDICTIONS_SHARED_SERVICE") == "1" else ["--standalone"]
child = subprocess.Popen([binary, *launch, "--session", session_id, directory], stdin=slave, stdout=slave, stderr=slave, env=os.environ, cwd=directory, start_new_session=True)
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

import re

def screen_text():
    return re.sub(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>]", "", output.decode(errors="replace"))

def capture(name):
    directory_ = os.environ.get("PREDICTIONS_CAPTURE_DIR")
    if directory_:
        pathlib.Path(directory_).mkdir(parents=True, exist_ok=True)
        pathlib.Path(directory_, name + ".txt").write_text(screen_text()[-4000:])

def send_and_wait(keys, expected, seconds=15):
    """Send keys, then wait until the real dialog paints the expected text."""
    output.clear()
    os.write(master, keys)
    pump_until(lambda: expected in screen_text(), seconds)

def settle(seconds):
    end = time.monotonic() + seconds
    pump_until(lambda: time.monotonic() >= end, seconds + 3)

def choose(label, wait=0.8):
    """Type to filter the real select dialog, then press Enter on the match."""
    output.clear()
    os.write(master, label.encode())
    pump_until(lambda: label in screen_text(), 10)
    settle(0.4)
    os.write(master, b"\r")
    settle(wait)

try:
    if os.environ.get("PREDICTIONS_SETUP_FULL") == "1":
        pump_until(lambda: pathlib.Path(observation + ".ready").exists())
        send_and_wait(b"\x1b[17~", "Predictions Setup")
        pump_until(lambda: "Behavior" in screen_text())
        capture("full-root")
        choose("Behavior")
        choose("Enable Predictions")
        choose("Predict After Replies")
        choose("Escalation Mode")
        choose("Automatically")
        pump_until(lambda: "Auto once" in screen_text())
        os.write(master, b"\x1b"); settle(0.8)
        choose("Advanced")
        choose("Timeout per model")
        os.write(master, b"\x01\x0b"); settle(0.3)
        os.write(master, b"9000\r"); settle(0.8)
        choose("Recent interactions")
        choose("5")
        choose("Include GitHub PR context")
        choose("Debug notices")
        capture("full-advanced")
        os.write(master, b"\x1b"); settle(0.8)
        choose("Models")
        choose("Group 2")
        choose("Move group up")
        capture("full-models")
        os.write(master, b"\x1b"); settle(0.6)
        os.write(master, b"\x1b"); settle(0.8)
        pump_until(lambda: "unsaved changes" in screen_text())
        choose("Save changes", 2.0)
        pump_until(lambda: "Saved" in screen_text(), 20)
        capture("full-saved")
        os.write(master, b"\r"); settle(1.0)
        # Leaving a saved (clean) menu needs no confirmation; reopening shows the saved values.
        os.write(master, b"\x1b"); settle(1.0)
        output.clear()
        os.write(master, b"\x1b[17~")
        pump_until(lambda: "Predictions Setup" in screen_text() and "PR on" in screen_text(), 20)
        capture("full-reopened")
        text = screen_text()
        assert "Off · After replies on · auto" in text and "9000 ms · 5 recent · PR on" in text, text[-1500:]
        print(json.dumps({"fullSetup": True, "host": json.loads(pathlib.Path(observation + ".host").read_text())}))
    elif os.environ.get("PREDICTIONS_SETUP_TEST") == "1":
        pump_until(lambda: pathlib.Path(observation + ".ready").exists())
        send_and_wait(b"\x1b[17~", "Predictions Setup")
        pump_until(lambda: "Behavior" in screen_text() and "Advanced" in screen_text())
        capture("root")
        assert "unsaved" not in screen_text()
        # Behavior is the first selectable row: open it and toggle Enable Predictions.
        send_and_wait(b"\r", "Enable Predictions")
        capture("behavior")
        os.write(master, b"\r")
        pump_until(lambda: "Off" in screen_text())
        output.clear()
        os.write(master, b"\x1b")
        pump_until(lambda: "unsaved changes" in screen_text())
        capture("root-dirty")
        # Type to filter, then choose Save changes.
        send_and_wait(b"Save", "Save changes")
        os.write(master, b"\r")
        pump_until(lambda: "Saved" in screen_text(), 20)
        capture("saved")
        os.write(master, b"\r")
        print(json.dumps({"setupSaved": True}))
    elif os.environ.get("PREDICTIONS_SAVE_TEST") == "1":
        pump_until(lambda: pathlib.Path(observation + ".ready").exists())
        automatic = os.environ.get("PREDICTIONS_SAVE_AUTOMATIC") == "true"
        model_calls = pathlib.Path(directory).parent.joinpath("prediction-models.json")
        def count_calls():
            try:
                return len(json.loads(model_calls.read_text()))
            except (FileNotFoundError, json.JSONDecodeError):
                return 0
        if automatic:
            wait_placeholder("Run the targeted tests.")
        else:
            # No prediction to wait for: poll until the real composer exists.
            path = pathlib.Path(observation)
            def composer_ready():
                if path.exists():
                    try:
                        if json.loads(path.read_text()).get("draft") is not None:
                            return True
                    except json.JSONDecodeError:
                        pass
                    path.unlink(missing_ok=True)
                os.write(master, b"\x1b[19~")
                return False
            path.unlink(missing_ok=True)
            pump_until(composer_ready)
        calls_before = count_calls()
        memory_file = pathlib.Path(observation + ".prediction-memory")
        before = json.loads(memory_file.read_text())
        os.write(master, b"my existing draft")
        observe("my existing draft")
        os.write(master, b"\x1b[23~")
        saved_file = pathlib.Path(observation + ".save")
        pump_until(lambda: saved_file.exists(), 15)
        saved = json.loads(saved_file.read_text())
        assert saved["kind"] in ("saved", "saved_not_active") and saved["active"] is True, saved
        observe("my existing draft")
        module = pathlib.Path(os.environ["PREDICTIONS_SAVE_MODULE"]).resolve()
        assert "save-predictions-" in str(module) and module.name == "tui.js"
        source = module.read_text()
        assert "moduleRevision = 1" in source
        module.write_text(source.replace("moduleRevision = 1", "moduleRevision = 2"))

        def predictions_remounted():
            try:
                value = json.loads(memory_file.read_text())
                return value["mounts"] > before["mounts"] and value["moduleRevision"] == 2
            except (FileNotFoundError, json.JSONDecodeError):
                return False

        pump_until(predictions_remounted)
        observe("my existing draft")
        os.write(master, b"\x01\x0b")
        observe("")
        deadline = time.monotonic() + 2.3
        pump_until(lambda: time.monotonic() >= deadline, 4)
        assert count_calls() == calls_before
        # A new completion is a new key: automatic mode predicts it, otherwise an explicit request does.
        os.write(master, b"Check the next assertion.\r")
        if automatic:
            pump_until(lambda: count_calls() == calls_before + 1, 20)
        else:
            end = time.monotonic() + 4
            pump_until(lambda: time.monotonic() >= end, 6)
            os.write(master, b"\x1b[112;4u")
            pump_until(lambda: count_calls() == calls_before + 1, 20)
        wait_placeholder("Run the targeted tests.")
        print(json.dumps({"saved": True, "composerPreserved": True, "predictionRemounted": True, "noSurprisePrediction": True}))
    elif os.environ.get("PREDICTIONS_MEMORY_TEST") == "1":
        pump_until(lambda: pathlib.Path(observation + ".ready").exists())
        memory_file = pathlib.Path(observation + ".memory")
        assert memory_file.is_file(), "Native memory probe is not implemented"
        before = json.loads(memory_file.read_text())
        assert before.get("available") is True, before
        assert before["generations"] >= 1, before
        if os.environ.get("PREDICTIONS_MEMORY_AUTOMATIC") == "true":
            wait_placeholder("Run the targeted tests.")
        os.write(master, b"my existing draft")
        observe("my existing draft")
        config_file = pathlib.Path(os.environ["PREDICTIONS_MEMORY_CONFIG"]).resolve()
        assert config_file.is_relative_to(pathlib.Path(observation).resolve().parent)
        assert config_file.name in ("opencode.json", "opencode.jsonc")
        # This replaces a synthetic test fixture, not a user's configuration or the production writer.
        config_file.write_text(os.environ["PREDICTIONS_MEMORY_NEXT_CONFIG"])
        module_file = pathlib.Path(os.environ["PREDICTIONS_MEMORY_MODULE"]).resolve()
        assert module_file.is_relative_to(pathlib.Path(observation).resolve().parent)
        module_file.write_text(module_file.read_text() + "\n// Fixture-owned source reload marker.\n")

        def reloaded_memory():
            try:
                value = json.loads(memory_file.read_text())
                return value["generations"] > before["generations"] and value["token"] == before["token"]
            except (FileNotFoundError, json.JSONDecodeError):
                return False

        pump_until(reloaded_memory)
        observe("my existing draft")
        os.write(master, b"\x01\x0b")
        observe("")
        # Pump beyond a status poll; detect requests through the fixture provider, not terminal frame timing.
        deadline = time.monotonic() + 2.3
        pump_until(lambda: time.monotonic() >= deadline, seconds=4)
        print(json.dumps({"memoryHandoff": True, "composerPreserved": True}))
    elif os.environ.get("PREDICTIONS_FEEDBACK_TEST") == "1":
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
    elif os.environ.get("PREDICTIONS_ALTERNATIVE_OUTCOME"):
        outcome = os.environ["PREDICTIONS_ALTERNATIVE_OUTCOME"]
        pump_until(lambda: pathlib.Path(observation + ".ready").exists())
        wait_placeholder("\ufffb…", contains=True)
        wait_placeholder("Original prediction.")
        observe("")
        os.write(master, b"\x1b[112;4u")
        wait_placeholder("\ufffb… Fixture second")
        def alternative_started():
            try:
                return "second" in json.loads(pathlib.Path(directory).parent.joinpath("prediction-models.json").read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                return False
        pump_until(alternative_started)
        observe("")
        os.write(master, b"\t")
        observe("")
        if outcome == "fallback":
            wait_placeholder("\ufffb… Fixture third")
            observe("")
        if outcome == "typing":
            os.write(master, b"my own prompt")
            observe("my own prompt")
            end = time.monotonic() + 2.8
            pump_until(lambda: time.monotonic() >= end, 4)
            observe("my own prompt")
            os.write(master, b"\x01\x0b")
        expected = "Run the targeted tests." if outcome in ("success", "fallback") else "Original prediction."
        wait_placeholder(expected)
        observe("")
        os.write(master, b"\t")
        observe(expected)
        print(json.dumps({"compactValidated": True}))
    elif os.environ.get("PREDICTIONS_ESCALATION_TEST") == "1":
        pump_until(lambda: pathlib.Path(observation + ".ready").exists())
        shortcut = "Option+Shift+P" if sys.platform == "darwin" else "Alt+Shift+P"
        wait_placeholder("[Fixture Flash] provided no prediction.\n" + shortcut + ": try [Fixture second].")
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
        pump_until(lambda: pathlib.Path(observation + ".ready").exists())
        if os.environ.get("PREDICTIONS_MANUAL_TEST") == "1":
            pump_until(lambda: pathlib.Path(observation + ".ready").exists() and b"Fix the assertion." in output)
            observe("")
            assert b"Run the targeted tests." not in output
            # CSI-u distinguishes Alt+Shift+P from the legacy ESC P DCS introducer.
            os.write(master, b"\x1b[112;4u")
            observe("")
        wait_placeholder("Run the targeted tests.")
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
