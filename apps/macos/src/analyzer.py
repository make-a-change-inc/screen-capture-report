import google.generativeai as genai
import os
from src.utils import get_config, setup_logger
from PIL import Image

logger = setup_logger(__name__)

class GeminiAnalyzer:
    def __init__(self):
        api_key = get_config("GEMINI_API_KEY")
        if not api_key or "your_gemini_api_key" in api_key:
            logger.warning("Gemini API Key is missing or invalid. Analysis will be skipped.")
            self.model = None
        else:
            genai.configure(api_key=api_key)
            model_name = get_config("ANALYSIS_MODEL_NAME", "gemini-1.5-flash")
            self.model = genai.GenerativeModel(model_name)

    def reload_config(self):
        """Reloads configuration (e.g. after setup)."""
        logger.info("Reloading Analyzer config...")
        api_key = get_config("GEMINI_API_KEY")
        if api_key:
             genai.configure(api_key=api_key)
             model_name = get_config("ANALYSIS_MODEL_NAME", "gemini-1.5-flash")
             self.model = genai.GenerativeModel(model_name)
             logger.info(f"Analyzer reloaded with model: {model_name}")
        else:
             logger.warning("Analyzer reload failed: API Key missing.")

    def analyze_batch(self, image_paths, current_log=""):
        """Analyzes a batch of images and updates the daily report."""
        if not self.model:
            return "Analysis skipped (No API Key)."

        try:
            images = [Image.open(p) for p in image_paths]
            
            prompt = f"""
あなたはユーザーの活動を記録するAIアシスタントです。
以下は、**現在の1時間**におけるこれまでの「活動ログ」です。
--------------------------------------------------
{current_log}
--------------------------------------------------

そして、以下に添付されている画像は、直近数分間のユーザーの画面キャプチャです。

**指示:**
0. 画像の内容から現在、対応している「案件名」「対応内容概要」「対応内容詳細」を読み取ってください。不明な場合は不明で良いです。
1. 画像からユーザーの新しい活動内容を読み取ってください。
2. 既存の「現在の1時間のログ」に、新しい活動内容を統合・追記し、**この1時間の活動まとめ**を更新してください。
3. 以前の情報を消さないように注意しつつ、重複は整理してください。
4. 出力は**更新されたこの1時間のテキストのみ**を行ってください（見出しや挨拶は不要）。
"""
            
            response = self.model.generate_content([prompt] + images)
            logger.info(f"Gemini analysis completed. Response length: {len(response.text)}")
            logger.debug(f"Response: {response.text}")
            return response.text
        except Exception as e:
            logger.error(f"Error during Gemini analysis: {e}")
            return f"Error during analysis: {e}"
