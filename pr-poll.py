import json, subprocess, sys, time

REPO = "namhtpyn/tandem"
PR = sys.argv[1] if len(sys.argv) > 1 else "411"
deadline = time.time() + 1700


def classify(proc):
    out = proc.stdout or ""
    if proc.returncode == 0:
        return "green", out
    if proc.returncode == 8 or not out.strip():
        return "pending", out
    return "fail", out


while time.time() < deadline:
    p = subprocess.run(
        ["gh", "pr", "checks", PR, "--repo", REPO],
        capture_output=True, text=True,
    )
    state, out = classify(p)
    if state == "green":
        print("GREEN")
        print(out[-1500:])
        sys.exit(0)
    if state == "fail":
        print("FAIL rc=", p.returncode)
        print(out[-3000:])
        sys.exit(1)
    time.sleep(20)
print("TIMEOUT")
sys.exit(2)
