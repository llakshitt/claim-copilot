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


def default_client():
    return GeminiClient()
