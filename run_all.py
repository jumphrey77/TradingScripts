import subprocess
import threading
import webbrowser
import time
import os
import sys

FASTAPI_PORT = 8000
REACT_PORT = 3000

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
REACT_DIR = os.path.join(BASE_DIR, "momentum-dashboard")

def start_flask_server_py():
    print("\n🚀 Starting server.py (legacy backend)...\n")
    subprocess.run([sys.executable, "server.py"], cwd=BASE_DIR)

def start_react():
    print("\n🚀 Starting React dashboard (CRA)...\n")
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    env = os.environ.copy()
    env["NODE_OPTIONS"] = "--no-deprecation"
    env["BROWSER"] = "none"  # ✅ prevents CRA from opening a tab
    #env["NODE_OPTIONS"] = "--no-warnings"
    subprocess.run([npm_cmd, "start"], cwd=REACT_DIR, env=env)

def open_browser():
    time.sleep(6)
    url = f"http://localhost:{REACT_PORT}"
    print(f"\n🌐 Opening browser at {url}\n")
    webbrowser.open(url, new=0)

if __name__ == "__main__":
    threading.Thread(target=start_flask_server_py, daemon=True).start()
    threading.Thread(target=start_react, daemon=True).start()
    threading.Thread(target=open_browser, daemon=True).start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n🛑 Exiting launcher...")
