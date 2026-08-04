import time
import schedule
import rumps
import threading
import os
from datetime import datetime
from src.capturer import ScreenCapturer
from src.analyzer import GeminiAnalyzer
from src.diagram import NanobananaClient
from src.notifier import EmailNotifier
from src.utils import setup_logger, get_config, get_data_dir, get_resource_path

logger = setup_logger(__name__)

from src.image_manager import ImageManager

class ScreenCaptureApp(rumps.App):
    def __init__(self):
        super(ScreenCaptureApp, self).__init__("SCApp")
        self.capturer = ScreenCapturer()
        self.analyzer = GeminiAnalyzer()
        self.diagram_client = NanobananaClient()
        self.notifier = EmailNotifier()
        self.image_manager = ImageManager()
        
        # Cleanup old captures on startup
        self.image_manager.cleanup_old_captures(days=1)
        
        self.current_batch = []
        self.daily_log = []
        self.is_running = False
        
        self.menu = ["Start Capture", "Stop Capture", None, "Capture Now", "Analyze Now", "Generate Report Now", None, "Open Data Folder", None, "Reset Settings"]
        
        # Start the scheduler in a separate thread
        self.scheduler_thread = threading.Thread(target=self.run_scheduler)
        self.scheduler_thread.daemon = True
        self.scheduler_thread.start()
        
        # Check for missed reports on startup
        self.flush_reports()
        
        # Check setup (Onboarding)
        self.check_setup()
        
        # Auto-start capture
        self.start_capture(None)

    def check_setup(self):
        """Checks if .env exists in data_dir. If not, tries to migrate or prompt user."""
        data_dir = get_data_dir()
        env_path = os.path.join(data_dir, ".env")
        
        if not os.path.exists(env_path):
            # Check if bundled .env exists (migration)
            bundled_env = get_resource_path(".env")
            if os.path.exists(bundled_env):
                logger.info("Migrating bundled .env to data directory...")
                import shutil
                try:
                    shutil.copy(bundled_env, env_path)
                    from dotenv import load_dotenv
                    load_dotenv(env_path, override=True)
                    self.analyzer.reload_config() 
                    return
                except Exception as e:
                    logger.error(f"Failed to migrate .env: {e}")
            
            # If still not exists, prompt user
            self.show_onboarding_window()

    def show_onboarding_window(self):
        logger.info("Showing onboarding window.")
        # Simple window to ask for API KEY
        window = rumps.Window(
            title="Screen Capture Report - Setup",
            message="Welcome! Please enter your Gemini API Key to start.\nYou can get one at: https://aistudio.google.com/app/apikey",
            default_text="",
            ok="Save",
            cancel="Quit"
        )
        window.icon = "app_icon.icns" # If available
        response = window.run()
        
        if response.clicked:
            api_key = response.text.strip()
            if api_key:
                self.save_api_key(api_key)
            else:
                 rumps.alert("API Key is required!")
                 rumps.quit_application()
        else:
            rumps.quit_application()

    def save_api_key(self, api_key):
        env_path = os.path.join(get_data_dir(), ".env")
        try:
            with open(env_path, "w") as f:
                f.write(f"GEMINI_API_KEY={api_key}\n")
                f.write("ANALYSIS_MODEL_NAME=gemini-1.5-flash\n")
                # Add basic defaults
                f.write("CAPTURE_MODE=active_window\n")
            
            logger.info("API Key saved.")
            
            # Reload env
            from dotenv import load_dotenv
            load_dotenv(env_path, override=True)
            self.analyzer.reload_config()
            rumps.alert("Setup Complete! The app will now run in the background.")
            
        except Exception as e:
            logger.error(f"Failed to save .env: {e}")
            rumps.alert(f"Failed to save settings: {e}")

    def run_scheduler(self):
        while True:
            if self.is_running:
                schedule.run_pending()
            time.sleep(1)

    def show_notification(self, title, subtitle, message):
        """Displays a notification using AppleScript."""
        try:
            # Escape quotes
            title = title.replace('"', '\\"')
            subtitle = subtitle.replace('"', '\\"')
            message = message.replace('"', '\\"')
            
            cmd = f'display alert "{title} - {subtitle}" message "{message}" as informational giving up after 2'
            # For debugging, we can try display alert if notification fails? No, too intrusive.
            import subprocess
            result = subprocess.run(["osascript", "-e", cmd], capture_output=True, text=True)
            if result.returncode != 0:
                logger.warning(f"Notification command failed: {result.stderr}")
        except Exception as e:
            logger.warning(f"Notification failed: {e}")

    def save_api_key(self, api_key):
        env_path = os.path.join(get_data_dir(), ".env")
        try:
            with open(env_path, "w") as f:
                f.write(f"GEMINI_API_KEY={api_key}\n")
                f.write("ANALYSIS_MODEL_NAME=gemini-1.5-flash\n")
                f.write("CAPTURE_MODE=active_window\n\n")
                
                f.write("# Email Configuration (Optional)\n")
                f.write("SMTP_SERVER=smtp.gmail.com\n")
                f.write("SMTP_PORT=587\n")
                f.write("SMTP_USER=your_email@gmail.com\n")
                f.write("SMTP_PASSWORD=your_app_password\n")
                f.write("EMAIL_FROM=your_email@gmail.com\n")
                f.write("EMAIL_TO=recipient@example.com\n")
            
            logger.info("API Key saved.")
            
            # Reload env
            from dotenv import load_dotenv
            load_dotenv(env_path, override=True)
            self.analyzer.reload_config()
            rumps.alert("Setup Complete! Settings saved to 'Open Data Folder' > .env")
            
        except Exception as e:
            logger.error(f"Failed to save .env: {e}")
            rumps.alert(f"Failed to save settings: {e}")

    @rumps.clicked("Start Capture")
    def start_capture(self, _):
        if not self.is_running:
            self.is_running = True
            schedule.every(1).minutes.do(self.capture_task)
            # Schedule end of day report (e.g., at 18:00)
            schedule.every().day.at("18:00").do(self.flush_reports)
            logger.info("Capture started.")
            self.show_notification("Screen Capture", "Started", "Screen capture has started.")

    def capture_task(self):
        filepath = self.capturer.capture()
        if filepath:
            self.current_batch.append(filepath)
            if len(self.current_batch) >= 5:
                self.process_batch()

    def process_batch(self, force=False):
        if not self.current_batch:
            return

        logger.info(f"Processing batch of {len(self.current_batch)} images...")
        
        try:
            # Read current log
            full_log_content = ""
            log_path = os.path.join(get_data_dir(), "daily_log.txt")
            if os.path.exists(log_path):
                with open(log_path, "r", encoding='utf-8') as f:
                    full_log_content = f.read()
    
            # Determine current hour block with DATE
            now = datetime.now()
            current_date_str = now.strftime("%Y-%m-%d")
            current_hour_str = now.strftime("%H:00 - %H:59")
            header = f"## [{current_date_str} {current_hour_str}]"
            
            past_log = full_log_content
            current_hour_log = ""
            
            # Check if we are already in the current hour block
            if header in full_log_content:
                # Split at the last occurrence of the header
                parts = full_log_content.rsplit(header, 1)
                past_log = parts[0].strip()
                current_hour_log = parts[1].strip()
            else:
                # New hour block
                past_log = full_log_content.strip()
                current_hour_log = ""
    
            # Analyze and get updated hourly report
            updated_hour_log = self.analyzer.analyze_batch(self.current_batch, current_hour_log)
            logger.info(f"Analysis Result (first 100 chars): {updated_hour_log[:100] if updated_hour_log else 'EMPTY'}")
            
            # Reconstruct the full log
            new_full_log = past_log
            if new_full_log:
                new_full_log += "\n\n"
                
            new_full_log += f"{header}\n{updated_hour_log}"
            
            # Overwrite log file
            with open(log_path, "w", encoding='utf-8') as f:
                f.write(new_full_log)
            
            # Update internal state
            self.daily_log = [new_full_log]
            
            # Clear batch
            self.current_batch = []
        except Exception as e:
            logger.error(f"Critical error in process_batch: {e}", exc_info=True)

    @rumps.clicked("Stop Capture")
    def stop_capture(self, _):
        if self.is_running:
            self.is_running = False
            schedule.clear()
            logger.info("Capture stopped.")
            self.show_notification("Screen Capture", "Stopped", "Screen capture has stopped.")

    @rumps.clicked("Capture Now")
    def manual_capture(self, _):
        logger.info("Manual capture triggered.")
        self.capture_task()
        self.show_notification("Screen Capture", "Captured", "Screen captured manually.")

    @rumps.clicked("Analyze Now")
    def manual_analyze(self, _):
        logger.info("Manual analysis triggered.")
        if not self.current_batch:
            logger.info("Batch empty, capturing one image for analysis...")
            self.capture_task()
            
        self.process_batch(force=True)
        self.show_notification("Screen Capture", "Analyzed", "Batch analysis completed.")

    @rumps.clicked("Generate Report Now")
    def manual_report(self, _):
        self.force_flush_reports()

    @rumps.clicked("Open Data Folder")
    def open_data_folder(self, _):
        import subprocess
        subprocess.call(["open", get_data_dir()])

    @rumps.clicked("Reset Settings")
    def reset_settings(self, _):
        response = rumps.alert(
            title="Reset Settings",
            message="Are you sure you want to delete .env and reset all settings? The application will quit.",
            ok="Reset & Quit",
            cancel="Cancel"
        )
        if response == 1: # OK clicked
            env_file = os.path.join(get_data_dir(), ".env")
            if os.path.exists(env_file):
                try:
                    os.remove(env_file)
                    logger.info(".env file deleted.")
                except Exception as e:
                    logger.error(f"Failed to delete .env: {e}")
                    rumps.alert(f"Failed to delete .env: {e}")
                    return
            rumps.quit_application()

    def capture_task(self):
        filepath = self.capturer.capture()
        if filepath:
            self.current_batch.append(filepath)
            if len(self.current_batch) >= 5:
                self.process_batch()

    def process_batch(self, force=False):
        if not self.current_batch:
            return

        logger.info(f"Processing batch of {len(self.current_batch)} images...")
        
        try:
            # Read current log
            full_log_content = ""
            log_path = os.path.join(get_data_dir(), "daily_log.txt")
            if os.path.exists(log_path):
                with open(log_path, "r", encoding='utf-8') as f:
                    full_log_content = f.read()
    
            # Determine current hour block with DATE
            now = datetime.now()
            current_date_str = now.strftime("%Y-%m-%d")
            current_hour_str = now.strftime("%H:00 - %H:59")
            header = f"## [{current_date_str} {current_hour_str}]"
            
            past_log = full_log_content
            current_hour_log = ""
            
            # Check if we are already in the current hour block
            if header in full_log_content:
                # Split at the last occurrence of the header
                parts = full_log_content.rsplit(header, 1)
                past_log = parts[0].strip()
                current_hour_log = parts[1].strip()
            else:
                # New hour block
                past_log = full_log_content.strip()
                current_hour_log = ""
    
            # Analyze and get updated hourly report
            updated_hour_log = self.analyzer.analyze_batch(self.current_batch, current_hour_log)
            logger.info(f"Analysis Result (first 100 chars): {updated_hour_log[:100] if updated_hour_log else 'EMPTY'}")
            
            # Reconstruct the full log
            new_full_log = past_log
            if new_full_log:
                new_full_log += "\n\n"
                
            new_full_log += f"{header}\n{updated_hour_log}"
            
            # Overwrite log file
            with open(log_path, "w", encoding='utf-8') as f:
                f.write(new_full_log)
            
            # Update internal state
            self.daily_log = [new_full_log]
            
            # Clear batch
            self.current_batch = []
        except Exception as e:
            logger.error(f"Critical error in process_batch: {e}", exc_info=True)

    def flush_reports(self):
        """Checks daily_log.txt for any reports that need to be sent (past days or today > 18:00)."""
        logger.info("Checking for pending reports...")
        
        log_path = os.path.join(get_data_dir(), "daily_log.txt")
        if not os.path.exists(log_path):
            return

        with open(log_path, "r", encoding='utf-8') as f:
            content = f.read()
            
        if not content.strip():
            return

        # Simple parsing strategy: Split by "## ["
        # This assumes the format "## [YYYY-MM-DD HH:MM - HH:MM]"
        # We will group by YYYY-MM-DD
        
        lines = content.split('\n')
        daily_contents = {} # { "YYYY-MM-DD": [list of lines] }
        current_date = None
        
        # Regex to find date in header
        import re
        header_pattern = re.compile(r"## \[(\d{4}-\d{2}-\d{2}) .*\]")
        
        # Buffer for lines that don't belong to a specific date header (e.g. old logs)
        # We'll assign them to "Today" or handle them separately. 
        # For now, let's assume if we can't find a date, it belongs to today.
        today_str = datetime.now().strftime("%Y-%m-%d")
        
        for line in lines:
            match = header_pattern.search(line)
            if match:
                current_date = match.group(1)
            
            target_date = current_date if current_date else today_str
            
            if target_date not in daily_contents:
                daily_contents[target_date] = []
            daily_contents[target_date].append(line)

        # Now determine which dates to send
        now = datetime.now()
        remaining_content = []
        
        for date_str, lines in daily_contents.items():
            report_content = "\n".join(lines).strip()
            if not report_content:
                continue

            should_send = False
            
            if date_str < today_str:
                # Past date: Send immediately
                should_send = True
            elif date_str == today_str:
                # Today: Send if time >= 18:00
                if now.hour >= 18:
                    should_send = True
            
            if should_send:
                logger.info(f"Sending report for {date_str}...")
                self.send_report(date_str, report_content)
            else:
                # Keep for later
                remaining_content.append(report_content)

        # Rewrite daily_log.txt with remaining content
        new_log_content = "\n\n".join(remaining_content)
        with open(log_path, "w", encoding='utf-8') as f:
            f.write(new_log_content)
            
        if not new_log_content:
            self.daily_log = []
        else:
            self.daily_log = [new_log_content]

    def send_report(self, date_str, report_content):
        """Generates diagram and sends email for a specific date."""
        # Create report directory
        date_obj = datetime.strptime(date_str, "%Y-%m-%d")
        date_dir_str = date_obj.strftime("%Y%m%d")
        
        report_dir = os.path.join(get_data_dir(), "data", "report", date_dir_str)
        if not os.path.exists(report_dir):
            os.makedirs(report_dir)

        # Archive text
        report_file_path = os.path.join(report_dir, "report.txt")
        with open(report_file_path, "w", encoding='utf-8') as f:
            f.write(report_content)
            
        # Generate diagram
        diagram_data = self.diagram_client.generate_diagram(report_content)
        diagram_path = None
        
        if diagram_data:
             diagram_filename = f"diagram_{datetime.now().strftime('%H%M%S')}.png"
             diagram_path = os.path.join(report_dir, diagram_filename)
             with open(diagram_path, "wb") as f:
                 f.write(diagram_data)
        
        # Send email
        subject = f"Daily Screen Capture Report - {date_str}"
        self.notifier.send_report(subject, report_content, diagram_path)
        
        try:
            rumps.notification("Screen Capture", "Report Sent", f"Report for {date_str} sent.")
        except Exception as e:
            logger.warning(f"Notification failed: {e}")

    def force_flush_reports(self):
        """Force sends all reports in the log regardless of time."""
        logger.info("Force flushing all reports...")
        log_path = os.path.join(get_data_dir(), "daily_log.txt")
        if not os.path.exists(log_path): 
            rumps.alert("No log file found.")
            return
        
        with open(log_path, "r", encoding='utf-8') as f: 
            content = f.read()
        
        if not content.strip(): 
            rumps.alert("Log file is empty. Nothing to report.")
            return
        
        lines = content.split('\n')
        daily_contents = {}
        current_date = None
        import re
        header_pattern = re.compile(r"## \[(\d{4}-\d{2}-\d{2}) .*\]")
        today_str = datetime.now().strftime("%Y-%m-%d")
        
        for line in lines:
            match = header_pattern.search(line)
            if match: current_date = match.group(1)
            target_date = current_date if current_date else today_str
            if target_date not in daily_contents: daily_contents[target_date] = []
            daily_contents[target_date].append(line)
            
        count = 0
        for date_str, lines in daily_contents.items():
            report_content = "\n".join(lines).strip()
            if report_content:
                logger.info(f"Forcing send report for {date_str}...")
                self.send_report(date_str, report_content)
                count += 1
        
        if count > 0:
            # Clear log
            with open(log_path, "w", encoding='utf-8') as f: f.write("")
            self.daily_log = []
            self.image_manager.cleanup_old_captures(days=1)
            rumps.alert(f"Generated {count} reports.\nCheck 'data/report' folder.")
        else:
            rumps.alert("No reports generated.")

if __name__ == "__main__":
    ScreenCaptureApp().run()
