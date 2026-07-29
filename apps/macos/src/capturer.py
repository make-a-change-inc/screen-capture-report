import mss
import mss.tools
import os
import Quartz
from Cocoa import NSWorkspace
from datetime import datetime
from PIL import Image
from src.utils import setup_logger, get_config, get_data_dir

logger = setup_logger(__name__)

class ScreenCapturer:
    def __init__(self, output_dir=None):
        if output_dir is None:
            self.output_dir = os.path.join(get_data_dir(), "data", "captures")
        else:
            self.output_dir = output_dir
            
        self.capture_count = 0
        if not os.path.exists(self.output_dir):
            os.makedirs(self.output_dir)

    def get_active_window_bounds(self):
        """
        Returns the bounds of the active window (left, top, width, height) using Quartz/Cocoa.
        """
        try:
            # Get the frontmost application
            active_app = NSWorkspace.sharedWorkspace().frontmostApplication()
            if not active_app:
                logger.warning("Could not determine frontmost application.")
                return None
                
            pid = active_app.processIdentifier()
            app_name = active_app.localizedName()
            
            # Get list of windows on screen
            options = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
            window_list = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID)
            
            # Find the first window that belongs to the active app
            # usage of kCGWindowLayer == 0 helps filter out overlays, menus, etc.
            for window in window_list:
                if window.get('kCGWindowOwnerPID') == pid:
                    # Default windows are at layer 0. 
                    # Some apps might use different layers, but 0 is standard for the main window.
                    if window.get('kCGWindowLayer', 0) == 0:
                        bounds = window.get('kCGWindowBounds')
                        
                        # Filter out tiny windows (tooltips, hidden windows)
                        w = int(bounds['Width'])
                        h = int(bounds['Height'])
                        
                        if w < 50 or h < 50:
                            continue
                            
                        x = int(bounds['X'])
                        y = int(bounds['Y'])
                        
                        window_title = window.get('kCGWindowName', '')
                        
                        logger.info(f"Targeting Active Window (Quartz): App='{app_name}', Title='{window_title}', Bounds=(x={x}, y={y}, w={w}, h={h})")
                        return {'left': x, 'top': y, 'width': w, 'height': h}
            
            logger.warning(f"No suitable window found for active app: {app_name} (PID: {pid})")
            return None

        except Exception as e:
            logger.error(f"Failed to get active window bounds via Quartz: {e}")
            return None

    def capture(self):
        """Captures the screen based on configuration."""
        self.capture_count += 1
        capture_mode = get_config("CAPTURE_MODE", "all_screens")
        
        if capture_mode == "active_window":
            # Every 5th capture, force full screen capture for context
            if self.capture_count % 5 == 0:
                logger.info(f"Capture count {self.capture_count}: Forcing full screen capture for context.")
                return self._capture_all_monitors()

            bounds = self.get_active_window_bounds()
            if bounds:
                return self._capture_region(bounds)
            else:
                logger.warning("Could not get active window bounds. Capturing all monitors instead.")
        
        return self._capture_all_monitors()

    def _capture_region(self, monitor):
        """Captures a specific region defined by monitor dict {'left', 'top', 'width', 'height'}."""
        with mss.mss() as sct:
            try:
                sct_img = sct.grab(monitor)
                img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
                
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                filename = f"capture_window_{timestamp}.png"
                filepath = os.path.join(self.output_dir, filename)
                
                img.save(filepath)
                logger.info(f"Active window captured: {filepath}")
                return filepath
            except Exception as e:
                logger.error(f"Failed to capture region: {e}")
                return None

    def _capture_all_monitors(self):
        """Captures all monitors and stitches them into a single image."""
        with mss.mss() as sct:
            monitors = sct.monitors[1:] # Skip index 0 (combined) as it may be unreliable
            
            if not monitors:
                logger.error("No monitors detected.")
                return None

            # Calculate total bounds
            min_x = min(m['left'] for m in monitors)
            min_y = min(m['top'] for m in monitors)
            max_x = max(m['left'] + m['width'] for m in monitors)
            max_y = max(m['top'] + m['height'] for m in monitors)
            
            total_width = max_x - min_x
            total_height = max_y - min_y
            
            # Create a new blank image
            canvas = Image.new('RGB', (total_width, total_height), (0, 0, 0))
            
            for i, monitor in enumerate(monitors):
                # Capture monitor
                sct_img = sct.grab(monitor)
                img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
                
                # Calculate position on canvas
                x = monitor['left'] - min_x
                y = monitor['top'] - min_y
                
                canvas.paste(img, (x, y))
            
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"capture_{timestamp}.png"
            filepath = os.path.join(self.output_dir, filename)
            
            canvas.save(filepath)
            logger.info(f"Screen captured (Stitched {len(monitors)} monitors): {filepath}")
            return filepath

if __name__ == "__main__":
    capturer = ScreenCapturer()
    capturer.capture()
