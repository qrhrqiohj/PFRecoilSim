"""RecoilSim launcher.

    python run.py            -> opens the shooting range in your browser
    python run.py --port 9000 --no-browser
"""
import argparse
import importlib
import subprocess
import sys

MIN_PY = (3, 9)


def ensure_numpy():
    try:
        importlib.import_module("numpy")
        return
    except ImportError:
        pass
    print("RecoilSim needs the 'numpy' package, which isn't installed.")
    ans = input("Install it now with pip? [Y/n] ").strip().lower()
    if ans not in ("", "y", "yes"):
        raise SystemExit("Install it with:  python -m pip install numpy")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "numpy"])


def main():
    if sys.version_info < MIN_PY:
        raise SystemExit(f"RecoilSim needs Python {MIN_PY[0]}.{MIN_PY[1]} or newer")
    parser = argparse.ArgumentParser(description="Roblox recoil simulator")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--data", help="path to a game_data.json(.gz) file")
    args = parser.parse_args()
    ensure_numpy()
    from recoilsim.server import serve
    serve(port=args.port, open_browser=not args.no_browser, data_path=args.data)


if __name__ == "__main__":
    main()
