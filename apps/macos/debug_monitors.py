import mss
import json

def debug_monitors():
    with mss.mss() as sct:
        print("MSS Monitors detected:")
        print(json.dumps(sct.monitors, indent=2))
        
        # Try capturing monitor 0 (all)
        try:
            filename = "debug_capture_all.png"
            sct.shot(mon=0, output=filename)
            print(f"Captured mon=0 to {filename}")
        except Exception as e:
            print(f"Failed to capture mon=0: {e}")

if __name__ == "__main__":
    debug_monitors()
