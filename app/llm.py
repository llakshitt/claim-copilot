"""LLM access. Only used to read documents and draft text, never to compute payouts.

Free-tier friendly: Gemini's free API tier by default. Keys come from environment
variables only. The live client is UNTESTED in CI (no network or key there); tests
use FakeLLM.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request


class LLMError(RuntimeError):
    pass


class FakeLLM:
    """Returns a canned response; records prompts. For tests."""

    def __init__(self, response: str):
        self.response = response
        self.prompts: list = []

    def generate(self, prompt: str) -> str:
        self.prompts.append(prompt)
        return self.response


class GeminiClient:
    def __init__(self, api_key: str | None = None, model: str | None = None, timeout: int = 60):
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY", "")
        self.model = model or os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
        self.timeout = timeout
        if not self.api_key:
            raise LLMError("GEMINI_API_KEY is not set")

    def generate(self, prompt: str) -> str:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"
        body = json.dumps({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
        }).encode()
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/json", "x-goog-api-key": self.api_key})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.load(resp)
            return data["candidates"][0]["content"]["parts"][0]["text"]
        except (urllib.error.URLError, KeyError, IndexError, json.JSONDecodeError) as e:
            raise LLMError(f"Gemini request failed: {e}") from e


class GroqClient:
    """Groq's OpenAI-compatible API (free tier). UNTESTED live in CI; tests use FakeLLM."""

    def __init__(self, api_key: str | None = None, model: str | None = None, timeout: int = 60):
        self.api_key = api_key or os.environ.get("GROQ_API_KEY", "")
        self.model = model or os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
        self.timeout = timeout
        if not self.api_key:
            raise LLMError("GROQ_API_KEY is not set")

    def generate(self, prompt: str) -> str:
        body = json.dumps({
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }).encode()
        req = urllib.request.Request(
            "https://api.groq.com/openai/v1/chat/completions", data=body, method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.load(resp)
            return data["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            raise LLMError(f"Groq returned HTTP {e.code}") from e
        except (urllib.error.URLError, KeyError, IndexError, json.JSONDecodeError) as e:
            raise LLMError(f"Groq request failed: {e}") from e


def default_client():
    """LLM_PROVIDER=groq|gemini; otherwise whichever key is set (Groq first)."""
    provider = os.environ.get("LLM_PROVIDER", "").lower()
    if provider == "gemini" or (not provider and not os.environ.get("GROQ_API_KEY")
                                and os.environ.get("GEMINI_API_KEY")):
        return GeminiClient()
    return GroqClient()
