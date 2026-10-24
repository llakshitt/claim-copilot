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

    def vision(self, prompt: str, image_data_url: str) -> str:
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
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}",
                     "Accept": "application/json", "User-Agent": "claim-copilot/1.0 (+https://github.com/llakshitt/claim-copilot)"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.load(resp)
            return data["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:200]
            except Exception:
                detail = ""
            raise LLMError(f"Groq returned HTTP {e.code}: {detail}".strip()) from e
        except (urllib.error.URLError, KeyError, IndexError, json.JSONDecodeError) as e:
            raise LLMError(f"Groq request failed: {e}") from e


def _groq_post(api_key: str, payload: dict, timeout: int) -> str:
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/chat/completions", data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}",
                 "Accept": "application/json", "User-Agent": "claim-copilot/1.0 (+https://github.com/llakshitt/claim-copilot)"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.load(resp)
        return data["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            detail = ""
        raise LLMError(f"Groq returned HTTP {e.code}: {detail}".strip()) from e
    except (urllib.error.URLError, KeyError, IndexError, json.JSONDecodeError, TimeoutError) as e:
        raise LLMError(f"Groq request failed: {e}") from e


_VISION_HINTS = ("llama-4", "vision", "-vl", "maverick", "scout")
_vision_cache: dict = {}


def groq_models(api_key: str, timeout: int = 20) -> list:
    req = urllib.request.Request("https://api.groq.com/openai/v1/models", headers={
        "Authorization": f"Bearer {api_key}", "Accept": "application/json",
        "User-Agent": "claim-copilot/1.0 (+https://github.com/llakshitt/claim-copilot)"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return sorted(m["id"] for m in json.load(resp)["data"])
    except (urllib.error.URLError, KeyError, json.JSONDecodeError, TimeoutError) as e:
        raise LLMError(f"Could not list Groq models: {e}") from e


def _vision_payload(model: str, prompt: str, image_data_url: str) -> dict:
    return {"model": model, "temperature": 0, "max_tokens": 4096,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data_url}}]}]}


def _groq_vision(self, prompt: str, image_data_url: str) -> str:
    """Use GROQ_VISION_MODEL if set; otherwise the default, and if the key cannot use it,
    pick whichever vision-capable model the key can actually see."""
    timeout = max(self.timeout, 90)
    explicit = os.environ.get("GROQ_VISION_MODEL")
    tried = [explicit or _vision_cache.get("model") or "meta-llama/llama-4-scout-17b-16e-instruct"]
    try:
        out = _groq_post(self.api_key, _vision_payload(tried[0], prompt, image_data_url), timeout)
        _vision_cache["model"] = tried[0]
        return out
    except LLMError as first:
        if explicit or "HTTP 404" not in str(first) and "HTTP 403" not in str(first):
            raise
        candidates = [m for m in groq_models(self.api_key) if any(h in m.lower() for h in _VISION_HINTS) and m not in tried]
        for m in candidates:
            try:
                out = _groq_post(self.api_key, _vision_payload(m, prompt, image_data_url), timeout)
                _vision_cache["model"] = m
                return out
            except LLMError:
                continue
        raise LLMError("No vision-capable Groq model is available to this API key. "
                       "Set GROQ_VISION_MODEL to a model your key can use.") from first


GroqClient.vision = _groq_vision


def default_client():
    """LLM_PROVIDER=groq|gemini; otherwise whichever key is set (Groq first)."""
    provider = os.environ.get("LLM_PROVIDER", "").lower()
    if provider == "gemini" or (not provider and not os.environ.get("GROQ_API_KEY")
                                and os.environ.get("GEMINI_API_KEY")):
        return GeminiClient()
    return GroqClient()
