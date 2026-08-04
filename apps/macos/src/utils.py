import os
import sys
import logging
from dotenv import load_dotenv

def get_resource_path(relative_path):
    """ Get absolute path to resource, works for dev and for Py2app """
    if "urllib3" in sys.modules:
         # Hack for some requests/urllib3 interactions in frozen apps
         pass

    if 'py2app' in sys.modules or os.environ.get('RESOURCEPATH'):
        # Py2app typically sets RESOURCEPATH
        base_path = os.environ.get('RESOURCEPATH')
        if not base_path:
             # Fallback: sys.argv[0] is in Contents/MacOS, resources are in Contents/Resources
             base_path = os.path.join(os.path.dirname(os.path.dirname(sys.argv[0])), "Resources")
    else:
        base_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    return os.path.join(base_path, relative_path)

def get_data_dir():
    """Returns the data file directory (Library/Application Support)."""
    app_support = os.path.expanduser("~/Library/Application Support/ScreenCaptureReport")
    if not os.path.exists(app_support):
        os.makedirs(app_support)
    return app_support

# Load environment variables
env_path = os.path.join(get_data_dir(), ".env")
load_dotenv(env_path)

# Configure logging
log_file = os.path.join(get_data_dir(), "app.log")
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(log_file, encoding='utf-8'),
        logging.StreamHandler()
    ]
)

def get_config(key, default=None):
    """Get configuration value from environment variables."""
    return os.getenv(key, default)

def setup_logger(name):
    """Get a logger instance."""
    return logging.getLogger(name)
