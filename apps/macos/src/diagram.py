import google.generativeai as genai
from src.utils import get_config, setup_logger

logger = setup_logger(__name__)

class NanobananaClient:
    def __init__(self):
        self.api_key = get_config("NANOBANANA_API_KEY")
        if not self.api_key or "your_nanobanana_api_key" in self.api_key:
            self.api_key = get_config("GEMINI_API_KEY") # Fallback to Gemini Key
            
        self.api_url = get_config("NANOBANANA_API_URL")
        self.model_name = get_config("NANOBANANA_MODEL_NAME", "nano-banana-pro-preview")
        
        if self.api_key:
            genai.configure(api_key=self.api_key)

    def generate_diagram(self, text_summary):
        """Generates a diagram based on the text summary."""
        if not self.api_key:
            logger.warning("API Key is missing. Diagram generation skipped.")
            return None

        try:
            logger.info(f"Generating diagram with model: {self.model_name}")
            model = genai.GenerativeModel(self.model_name)
            
            prompt = f"以下の日報の内容を要約した、分かりやすい図解（インフォグラフィック）画像を生成してください。対応した「案件名」「対応内容概要」「対応内容詳細」「対応時間」を軸にまとめて。テキストは日本語でお願いします。最後に文字を清書するように再生成してください。文字以外の要素は変更禁止です。\n\n{text_summary}"
            
            # Call API
            response = model.generate_content(prompt)
            
            # Check for image in response
            # Note: The exact structure depends on the model version, but typically it's in parts
            if response.parts:
                for part in response.parts:
                    if hasattr(part, "inline_data") and part.inline_data:
                        logger.info("Image generated successfully.")
                        return part.inline_data.data # Returns bytes
                    # Fallback for some preview models that might return image in a different way
                    # or if the library wraps it differently.
            
            # If no inline_data, check if it returned text (maybe it refused or failed)
            if response.text:
                logger.warning(f"Model returned text instead of image: {response.text[:100]}...")
            
            return None

        except Exception as e:
            logger.error(f"Failed to generate diagram: {e}")
            return None
