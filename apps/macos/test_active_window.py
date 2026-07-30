import subprocess

def get_active_window_info():
    # AppleScript to get the bounds of the frontmost window
    # Returns: x, y, width, height
    script = '''
    tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set frontAppName to name of frontApp
        tell frontApp
            if (count of windows) > 0 then
                set appWindow to first window
                set {x, y} to position of appWindow
                set {w, h} to size of appWindow
                return {frontAppName, x, y, w, h}
            else
                return {frontAppName, "No Window"}
            end if
        end tell
    end tell
    '''
    
    try:
        p = subprocess.Popen(['osascript', '-e', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        output, error = p.communicate()
        
        if error:
            print(f"Error: {error}")
            return None
            
        print(f"Raw Output: {output.strip()}")
        return output.strip()

    except Exception as e:
        print(f"Exception: {e}")
        return None

if __name__ == "__main__":
    get_active_window_info()
