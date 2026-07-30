import os
import time
import shutil
from datetime import datetime, timedelta
from src.utils import setup_logger

logger = setup_logger(__name__)

class ImageManager:
    def __init__(self, capture_dir="data/captures", data_dir="data"):
        self.capture_dir = capture_dir
        self.data_dir = data_dir
        if not os.path.exists(self.capture_dir):
            os.makedirs(self.capture_dir)
        if not os.path.exists(self.data_dir):
            os.makedirs(self.data_dir)

    def save_diagram(self, image_data, filename=None):
        """Saves the diagram image data to the data directory."""
        if not filename:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"diagram_{timestamp}.png"
        
        filepath = os.path.join(self.data_dir, filename)
        try:
            with open(filepath, "wb") as f:
                f.write(image_data)
            logger.info(f"Diagram saved to: {filepath}")
            return filepath
        except Exception as e:
            logger.error(f"Failed to save diagram: {e}")
            return None

    def cleanup_old_captures(self, days=1):
        """Deletes capture files older than the specified number of days."""
        logger.info(f"Cleaning up captures older than {days} days...")
        now = time.time()
        cutoff = now - (days * 86400)
        
        count = 0
        for filename in os.listdir(self.capture_dir):
            filepath = os.path.join(self.capture_dir, filename)
            if os.path.isfile(filepath):
                if os.path.getmtime(filepath) < cutoff:
                    try:
                        os.remove(filepath)
                        count += 1
                    except Exception as e:
                        logger.error(f"Failed to delete {filepath}: {e}")
        
        logger.info(f"Cleanup completed. Deleted {count} files.")
