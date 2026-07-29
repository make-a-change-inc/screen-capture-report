import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.image import MIMEImage
from src.utils import get_config, setup_logger

logger = setup_logger(__name__)

class EmailNotifier:
    def __init__(self):
        self.smtp_server = get_config("SMTP_SERVER")
        self.smtp_port = int(get_config("SMTP_PORT", 587))
        self.smtp_user = get_config("SMTP_USER")
        self.smtp_password = get_config("SMTP_PASSWORD")
        self.email_from = get_config("EMAIL_FROM")
        self.email_to = get_config("EMAIL_TO")

    def send_report(self, subject, body, image_path=None):
        """Sends an email with the report and optional diagram."""
        if not self.smtp_user or "your_email" in self.smtp_user:
            logger.warning("Email configuration missing. Email sending skipped.")
            return

        try:
            msg = MIMEMultipart()
            msg['From'] = self.email_from
            msg['To'] = self.email_to
            msg['Subject'] = subject

            msg.attach(MIMEText(body, 'plain'))

            if image_path:
                with open(image_path, 'rb') as f:
                    img_data = f.read()
                    image = MIMEImage(img_data, name="diagram.png")
                    msg.attach(image)

            server = smtplib.SMTP(self.smtp_server, self.smtp_port)
            server.starttls()
            server.login(self.smtp_user, self.smtp_password)
            server.send_message(msg)
            server.quit()
            logger.info("Email sent successfully.")
        except Exception as e:
            logger.error(f"Failed to send email: {e}")
