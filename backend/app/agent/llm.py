"""Provider-agnostic LLM adapter with disk-backed request-hash cache and Retry-After backoff.

- `LLM_PROVIDER=fake` runs offline with zero API keys (replaying `domain_config.DOMAIN["demo"]`).
- `LLM_PROVIDER=gemini` uses Google Gemini REST API (`GEMINI_API_KEY`, default `gemini-3.8-flash`).
- `LLM_PROVIDER=groq|openai|grok` uses OpenAI-compatible Chat Completions with native tool calling.
- `LLM_PROVIDER=anthropic` uses Claude Messages API with native tool_use blocks.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

from ..contracts import ToolCall
from ..domain_config import get_domain

CACHE_DIR = Path(os.getenv("LLM_CACHE_DIR", ".llm_cache"))


@dataclass
class LLMResponse:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def cost_eur(self) -> float:
        return round((self.input_tokens * 3.0 + self.output_tokens * 15.0) / 1_000_000, 5)


class LLMProvider(Protocol):
    def complete(
        self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> LLMResponse: ...


def _cache_key(
    model: str, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None
) -> str:
    raw = json.dumps(
        {"m": model, "s": system, "msgs": messages, "t": tools or []}, sort_keys=True, default=str
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class FakeProvider:
    """Deterministic multi-agent script driven by `get_domain()["demo"]` in `domain_config.py`.

    - Responds to planner, forge spec/codegen, and anticipate JSON prompts deterministically.
    - In the ReAct loop, coordinates role-tagged tool calls across evidence reading (`read_file`),
      database lookup (`query_db`), synthesized contract calculation (`compute_supplier_claim`),
      reversible SQLite updates (`upsert_row` on `claims` and `invoices`), claim letter generation
      (`write_file`), and gated supplier correspondence (`send_email`).
    """

    def __init__(self) -> None:
        self.turn = 0
        self.known_tables: set[str] = set()

    @staticmethod
    def _demo() -> dict[str, Any]:
        return get_domain()["demo"]

    def _mutations(self) -> list[dict[str, Any]]:
        demo = self._demo()
        raw_list: list[dict[str, Any]] = []
        if "mutations" in demo and isinstance(demo["mutations"], list):
            raw_list.extend(demo["mutations"])
        elif "mutation" in demo and isinstance(demo["mutation"], dict):
            raw_list.append(demo["mutation"])
        if not self.known_tables:
            return raw_list
        return [m for m in raw_list if m.get("table") in self.known_tables]

    def complete(
        self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> LLMResponse:
        sys_low = system.lower()
        user_first = str(messages[0].get("content", "")) if messages else ""
        user_last = str(messages[-1].get("content", "")) if messages else ""
        demo = self._demo()
        forge_cfg: dict[str, Any] | None = demo.get("forge")
        forge_name = str((forge_cfg or {}).get("name") or "compute_supplier_claim")
        forge_title = str(
            (forge_cfg or {}).get("step_title") or "Calculate the claim under the supply contract"
        )
        notify = demo["notify"]
        notify_tool = str(notify.get("tool") or "send_email")
        if notify_tool == "trigger_webhook":
            notify_args: dict[str, Any] = {
                "endpoint": notify.get("endpoint") or notify.get("url", "https://hooks.internal/ops"),
                "event": notify.get("event", "ops.alert"),
                "payload": notify.get(
                    "payload",
                    {"subject": notify.get("subject", ""), "body": notify.get("body", "")},
                ),
            }
        else:
            notify_args = {
                "to": notify.get("to", "accounts@kappaoffice.example"),
                "subject": notify.get("subject", "Claim notification"),
                "body": notify.get("body", ""),
            }

        def _is_anticipate_goal(text: str) -> bool:
            low = text.lower().strip()
            ant_prompt = str(demo.get("anticipate", {}).get("goal_prompt", "")).lower().strip()
            if ant_prompt and low == ant_prompt:
                return True
            return any(
                marker in low
                for marker in ("d-1017", "d-1031", "follow-up", "followup", "earlier deliveries", "escalation")
            )

        def _wants_forge(text: str) -> bool:
            if _is_anticipate_goal(text):
                return False
            low = text.lower()
            if forge_cfg:
                kws = forge_cfg.get("trigger_keywords") or ["recover", "claim", "owes", "credit", forge_name]
                if any(str(kw).lower() in low for kw in kws):
                    return True
            return "claim" in low or "forge" in low

        # 1. Planner prompt (Contract Strategist)
        if "return strict json matching planpayload" in sys_low:
            self.known_tables |= set(re.findall(r"^Table (\w+):", user_last, re.MULTILINE))
            goal = user_last.split("Goal:", 1)[-1].strip()
            if _is_anticipate_goal(goal):
                ant = demo["anticipate"]
                return LLMResponse(
                    text=json.dumps(
                        {
                            "goal": goal,
                            "steps": [
                                {
                                    "id": 1,
                                    "intent": "[Revenue Hunter] Draft bundled follow-up claim for D-1017 and D-1031",
                                    "tool": "write_file",
                                }
                            ],
                            "success_criteria": [f"{ant['path']} exists"],
                        }
                    ),
                    input_tokens=160,
                    output_tokens=60,
                )

            need_forge = _wants_forge(goal)
            intents: list[tuple[str, str]] = []
            if "evidence" in demo:
                intents.append((f"[Forensic Auditor] {demo['evidence']['intent']}", "read_file"))
            if "lookup" in demo:
                intents.append((f"[Contract Strategist] {demo['lookup']['intent']}", "query_db"))
            if need_forge:
                intents.append((f"[Forge Engineer] {forge_title}", f"MISSING:{forge_name}"))
            for m in self._mutations():
                intents.append((f"[Rehearsal Executor] {m['intent']}", "upsert_row"))
            intents.append((f"[Rehearsal Executor] {demo['report']['intent']}", "write_file"))
            intents.append((f"[Compliance Critic] {notify['intent']}", notify_tool))
            steps = [{"id": i, "intent": intent, "tool": tool} for i, (intent, tool) in enumerate(intents, 1)]
            return LLMResponse(
                text=json.dumps(
                    {
                        "goal": goal,
                        "steps": steps,
                        "success_criteria": [f"{demo['report']['path']} exists", notify["criterion"]],
                    }
                ),
                input_tokens=195,
                output_tokens=110,
            )

        # 2. Forge spec prompt (Forge Engineer)
        if "forgespecpayload" in sys_low:
            m = re.search(r"Missing tool:\s*([^\n\r]+)", user_last)
            req_name = m.group(1).strip() if m else forge_name
            if forge_cfg and req_name == forge_name:
                spec_payload = {
                    "name": forge_name,
                    "purpose": forge_cfg.get("purpose", f"Execute helper {forge_name}"),
                    "input_schema": forge_cfg.get(
                        "input_schema",
                        {
                            "type": "object",
                            "properties": {
                                "qty_billed": {"type": "integer"},
                                "qty_received": {"type": "integer"},
                                "qty_damaged": {"type": "integer"},
                                "billed_unit_price": {"type": "number"},
                                "contract_unit_price": {"type": "number"},
                                "days_late": {"type": "integer"},
                                "late_penalty_pct_per_day": {"type": "number"},
                                "max_penalty_pct": {"type": "number"},
                            },
                            "required": [
                                "qty_billed",
                                "qty_received",
                                "qty_damaged",
                                "billed_unit_price",
                                "contract_unit_price",
                                "days_late",
                                "late_penalty_pct_per_day",
                                "max_penalty_pct",
                            ],
                        },
                    ),
                    "output_schema": {"type": "object"},
                    "examples": forge_cfg.get("examples", [{"in": {"value": "ok"}, "out": {"value": "ok"}}]),
                }
            else:
                spec_payload = {
                    "name": req_name,
                    "purpose": f"Pure deterministic helper `{req_name}`",
                    "input_schema": {"type": "object", "properties": {"value": {"type": "string"}}},
                    "output_schema": {"type": "object"},
                    "examples": [{"in": {"value": "ok"}, "out": {"value": "ok", "ok": True}}],
                }
            return LLMResponse(text=json.dumps(spec_payload), input_tokens=220, output_tokens=130)

        # 3. Forge codegen prompt (Forge Engineer)
        if "write only pure python" in sys_low:
            m = re.search(r"Function name:\s*([a-zA-Z0-9_]+)", user_last)
            fn_name = m.group(1).strip() if m else forge_name
            if forge_cfg and fn_name == forge_name and forge_cfg.get("code"):
                code = str(forge_cfg["code"])
            else:
                code = (
                    f"def {fn_name}(args: dict) -> dict:\n"
                    "    out = dict(args)\n"
                    "    out['ok'] = True\n"
                    "    return out\n"
                )
            return LLMResponse(text=code, input_tokens=200, output_tokens=95)

        # 4. Anticipate prompt (Revenue Hunter)
        if "return strict json matching anticipateprediction" in sys_low:
            ant = demo["anticipate"]
            return LLMResponse(
                text=json.dumps(
                    {
                        "need": ant["need"],
                        "goal_prompt": ant["goal_prompt"],
                        "evidence": ant["evidence"],
                        "confidence": 0.92,
                        "kind": "draft",
                    }
                ),
                input_tokens=240,
                output_tokens=90,
            )

        # 5. ReAct tool-calling loop
        self.turn += 1
        tool_names = {t["name"] for t in (tools or [])}
        follow_up = _is_anticipate_goal(user_first)
        if self.turn == 1:
            if follow_up:
                ant = demo["anticipate"]
                return LLMResponse(
                    text="[Revenue Hunter] Drafting bundled follow-up claim for D-1017 and D-1031.",
                    tool_calls=[
                        ToolCall(
                            id="c_followup",
                            name="write_file",
                            args={"path": ant["path"], "content": ant["content"]},
                            thought=f"[Revenue Hunter] Drafting follow-up claim from evidence: {ant['evidence']}.",
                        )
                    ],
                    input_tokens=150,
                    output_tokens=70,
                )

            calls: list[ToolCall] = []
            if "evidence" in demo and "read_file" in tool_names:
                ev = demo["evidence"]
                calls.append(
                    ToolCall(
                        id="c_evidence",
                        name="read_file",
                        args={"path": ev["path"]},
                        thought=f"[Forensic Auditor] {ev.get('thought') or ev['intent']}",
                    )
                )
            if "lookup" in demo and "query_db" in tool_names:
                lk = demo["lookup"]
                calls.append(
                    ToolCall(
                        id="c_lookup",
                        name="query_db",
                        args={"sql": lk["sql"]},
                        thought=f"[Contract Strategist] {lk['intent']}.",
                    )
                )
            if forge_name in tool_names and _wants_forge(user_first):
                call_args = dict((forge_cfg or {}).get("call_args", {}))
                calls.append(
                    ToolCall(
                        id="c_forge",
                        name=forge_name,
                        args=call_args,
                        thought=f"[Forge Engineer] Running sandbox-verified `{forge_name}` on delivery D-1042.",
                    )
                )
            if "upsert_row" in tool_names:
                for idx, mutation in enumerate(self._mutations(), 1):
                    calls.append(
                        ToolCall(
                            id=f"c_db_{idx}",
                            name="upsert_row",
                            args={
                                "table": mutation["table"],
                                "pk_col": mutation["pk_col"],
                                "row": dict(mutation["row"]),
                            },
                            thought=f"[Rehearsal Executor] {mutation['thought']}",
                        )
                    )
            report = demo["report"]
            calls.append(
                ToolCall(
                    id="c_report",
                    name="write_file",
                    args={"path": report["path"], "content": report["content"]},
                    thought=f"[Rehearsal Executor] Writing claim dossier `{report['path']}`.",
                )
            )
            return LLMResponse(
                text="[Rehearsal Executor] Staging claim calculation, database holds, and claim letter.",
                tool_calls=calls,
                input_tokens=230,
                output_tokens=105,
            )

        if self.turn == 2 and not follow_up:
            return LLMResponse(
                text=f"[Compliance Critic] Queueing {notify_tool} for manager Risk Gate approval.",
                tool_calls=[
                    ToolCall(
                        id="c_notify",
                        name=notify_tool,
                        args=notify_args,
                        thought=(
                            "[Compliance Critic] Verified 3-way match; "
                            "queueing supplier claim email for approval."
                        ),
                    )
                ],
                input_tokens=260,
                output_tokens=80,
            )
        return LLMResponse(text="Done.", input_tokens=120, output_tokens=20)


def _cache_read(cache_file: Path) -> LLMResponse | None:
    if not cache_file.exists():
        return None
    data = json.loads(cache_file.read_text(encoding="utf-8"))
    return LLMResponse(
        text=data["text"],
        tool_calls=[ToolCall(**c) for c in data["tool_calls"]],
        input_tokens=data["input_tokens"],
        output_tokens=data["output_tokens"],
    )


def _cache_write(cache_file: Path, resp: LLMResponse) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(
        json.dumps(
            {
                "text": resp.text,
                "tool_calls": [
                    asdict(c) if hasattr(c, "__dataclass_fields__") else c.model_dump()
                    for c in resp.tool_calls
                ],
                "input_tokens": resp.input_tokens,
                "output_tokens": resp.output_tokens,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _post_with_retry(
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    max_attempts: int = 5,
) -> dict[str, Any]:
    import httpx

    for attempt in range(max_attempts):
        r = httpx.post(url, headers=headers, json=payload, timeout=45.0)
        if r.status_code in {429, 500, 502, 503, 504} and attempt < max_attempts - 1:
            raw_ra = r.headers.get("retry-after", "")
            try:
                delay = max(1.0, min(25.0, float(raw_ra) + 0.5))
            except ValueError:
                delay = min(15.0, 1.5 * (2**attempt))
            time.sleep(delay)
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError("Exhausted HTTP retries")


class AnthropicProvider:
    """Claude Messages API adapter with native tool_use blocks and optional disk cache."""

    def __init__(self, model: str) -> None:
        self._client: Any = None
        self.model = model
        self.use_cache = os.getenv("LLM_CACHE", "1") == "1"

    def _get_client(self) -> Any:
        if self._client is None:
            import anthropic

            self._client = anthropic.Anthropic()
        return self._client

    def complete(
        self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> LLMResponse:
        key = _cache_key(self.model, system, messages, tools)
        cache_file = CACHE_DIR / f"{key}.json"
        if self.use_cache:
            cached = _cache_read(cache_file)
            if cached is not None:
                return cached

        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": 2048,
            "system": system,
            "messages": messages,
        }
        if tools:
            kwargs["tools"] = tools

        try:
            r = self._get_client().messages.create(**kwargs)
        except Exception:
            if os.getenv("LLM_FALLBACK_FAKE", "1") == "1":
                return FakeProvider().complete(system, messages, tools)
            raise
        text = "".join(b.text for b in r.content if b.type == "text")
        calls = [
            ToolCall(id=b.id, name=b.name, args=dict(b.input), thought=text or None)
            for b in r.content
            if b.type == "tool_use"
        ]
        resp = LLMResponse(text, calls, r.usage.input_tokens, r.usage.output_tokens)
        if self.use_cache:
            _cache_write(cache_file, resp)
        return resp


def _sanitize_gemini_schema(schema: Any) -> Any:
    """Strip JSON Schema keywords rejected by Gemini's functionDeclarations schema."""
    if isinstance(schema, list):
        return [_sanitize_gemini_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    cleaned: dict[str, Any] = {}
    for k, v in schema.items():
        if k in {"additionalProperties", "$schema"}:
            continue
        cleaned[k] = _sanitize_gemini_schema(v)
    return cleaned


def _to_gemini_contents(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert plain/Anthropic-formatted conversation turns into Gemini `contents`."""
    id_to_name: dict[str, str] = {}
    contents: list[dict[str, Any]] = []
    for msg in messages:
        role = "model" if msg.get("role") == "assistant" else "user"
        raw = msg.get("content", "")
        if isinstance(raw, str):
            contents.append({"role": role, "parts": [{"text": raw}]})
            continue
        parts: list[dict[str, Any]] = []
        for block in raw:
            btype = block.get("type")
            if btype == "text":
                parts.append({"text": block.get("text", "")})
            elif btype == "tool_use":
                tid = str(block.get("id", ""))
                name = str(block.get("name", ""))
                if tid and name:
                    id_to_name[tid] = name
                parts.append({"functionCall": {"name": name, "args": block.get("input", {})}})
            elif btype == "tool_result":
                tid = str(block.get("tool_use_id", ""))
                name = id_to_name.get(tid, tid or "tool")
                raw_payload = block.get("content", "{}")
                try:
                    parsed = json.loads(raw_payload) if isinstance(raw_payload, str) else raw_payload
                except Exception:  # noqa: BLE001
                    parsed = {"result": str(raw_payload)}
                if not isinstance(parsed, dict):
                    parsed = {"result": parsed}
                parts.append({"functionResponse": {"name": name, "response": parsed}})
        if parts:
            contents.append({"role": role, "parts": parts})
    return contents


class GeminiProvider:
    """Google Gemini REST API adapter supporting AI Studio and Vertex endpoints."""

    AI_STUDIO_URL = "https://generativelanguage.googleapis.com/v1beta/models"

    def __init__(self, model: str = "gemini-3.8-flash") -> None:
        self.model = model
        self.use_cache = os.getenv("LLM_CACHE", "1") == "1"

    def _endpoint_url(self) -> str:
        base = os.getenv("GEMINI_BASE_URL", "").strip().rstrip("/") or self.AI_STUDIO_URL
        return f"{base}/{self.model}:generateContent"

    def complete(
        self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> LLMResponse:
        key = _cache_key(self.model, system, messages, tools)
        cache_file = CACHE_DIR / f"{key}.json"
        if self.use_cache:
            cached = _cache_read(cache_file)
            if cached is not None:
                return cached

        api_key = os.getenv("GEMINI_API_KEY", "").strip()
        if not api_key:
            if os.getenv("LLM_FALLBACK_FAKE", "1") == "1":
                return FakeProvider().complete(system, messages, tools)
            raise RuntimeError("GEMINI_API_KEY is not set")

        payload: dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": _to_gemini_contents(messages),
            "generationConfig": {"maxOutputTokens": 2048},
        }
        if tools:
            payload["tools"] = [
                {
                    "functionDeclarations": [
                        {
                            "name": t["name"],
                            "description": t.get("description", ""),
                            "parameters": _sanitize_gemini_schema(
                                t.get("input_schema", {"type": "object"})
                            ),
                        }
                        for t in tools
                    ]
                }
            ]

        url = self._endpoint_url()
        try:
            data = _post_with_retry(url, {"x-goog-api-key": api_key}, payload)
        except Exception:
            if os.getenv("LLM_FALLBACK_FAKE", "1") == "1":
                return FakeProvider().complete(system, messages, tools)
            raise

        candidates = data.get("candidates") or []
        parts = ((candidates[0].get("content") or {}).get("parts") or []) if candidates else []
        texts: list[str] = []
        calls: list[ToolCall] = []
        for idx, part in enumerate(parts):
            if "text" in part:
                texts.append(part["text"])
            elif "functionCall" in part:
                fc = part["functionCall"]
                name = str(fc.get("name", ""))
                args = dict(fc.get("args") or {})
                calls.append(
                    ToolCall(
                        id=f"gem_{idx}_{name}",
                        name=name,
                        args=args,
                        thought="".join(texts) or None,
                    )
                )

        usage = data.get("usageMetadata") or {}
        resp = LLMResponse(
            text="".join(texts),
            tool_calls=calls,
            input_tokens=int(usage.get("promptTokenCount", 0)),
            output_tokens=int(usage.get("candidatesTokenCount", 0)),
        )
        if self.use_cache:
            _cache_write(cache_file, resp)
        return resp


def _to_openai_messages(system: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert plain/Anthropic-formatted turns into OpenAI Chat Completions messages."""
    out: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for msg in messages:
        role = msg.get("role", "user")
        raw = msg.get("content", "")
        if isinstance(raw, str):
            out.append({"role": role, "content": raw})
            continue
        texts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        tool_results: list[dict[str, Any]] = []
        for block in raw:
            btype = block.get("type")
            if btype == "text":
                texts.append(block.get("text", ""))
            elif btype == "tool_use":
                tool_calls.append(
                    {
                        "id": str(block.get("id", "")),
                        "type": "function",
                        "function": {
                            "name": str(block.get("name", "")),
                            "arguments": json.dumps(block.get("input", {})),
                        },
                    }
                )
            elif btype == "tool_result":
                tool_results.append(
                    {
                        "role": "tool",
                        "tool_call_id": str(block.get("tool_use_id", "")),
                        "content": str(block.get("content", "")),
                    }
                )
        if role == "assistant" and (texts or tool_calls):
            entry: dict[str, Any] = {"role": "assistant", "content": "\n".join(texts) or None}
            if tool_calls:
                entry["tool_calls"] = tool_calls
            out.append(entry)
        elif texts:
            out.append({"role": role, "content": "\n".join(texts)})
        out.extend(tool_results)
    return out


class OpenAICompatProvider:
    """OpenAI-compatible Chat Completions adapter (Groq, OpenAI, xAI Grok, OpenRouter)."""

    def __init__(
        self,
        model: str,
        base_url: str,
        api_key_env: str = "OPENAI_API_KEY",
    ) -> None:
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.api_key_env = api_key_env
        self.use_cache = os.getenv("LLM_CACHE", "1") == "1"

    def complete(
        self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> LLMResponse:
        key = _cache_key(self.model, system, messages, tools)
        cache_file = CACHE_DIR / f"{key}.json"
        if self.use_cache:
            cached = _cache_read(cache_file)
            if cached is not None:
                return cached

        api_key = os.getenv(self.api_key_env, "").strip()
        if not api_key:
            if os.getenv("LLM_FALLBACK_FAKE", "1") == "1":
                return FakeProvider().complete(system, messages, tools)
            raise RuntimeError(f"{self.api_key_env} is not set")

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": _to_openai_messages(system, messages),
            "max_tokens": 2048,
        }
        if tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t["name"],
                        "description": t.get("description", ""),
                        "parameters": t.get("input_schema", {"type": "object"}),
                    },
                }
                for t in tools
            ]

        url = f"{self.base_url}/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}"}
        try:
            data = _post_with_retry(url, headers, payload)
        except Exception:
            if os.getenv("LLM_FALLBACK_FAKE", "1") == "1":
                return FakeProvider().complete(system, messages, tools)
            raise

        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        text = msg.get("content") or ""
        calls: list[ToolCall] = []
        for idx, tc in enumerate(msg.get("tool_calls") or []):
            fn = tc.get("function") or {}
            raw_args = fn.get("arguments") or "{}"
            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
            except Exception:  # noqa: BLE001
                args = {}
            calls.append(
                ToolCall(
                    id=str(tc.get("id") or f"oai_{idx}_{fn.get('name', 'tool')}"),
                    name=str(fn.get("name", "")),
                    args=args,
                    thought=text or None,
                )
            )
        usage = data.get("usage") or {}
        resp = LLMResponse(
            text=text,
            tool_calls=calls,
            input_tokens=int(usage.get("prompt_tokens", 0)),
            output_tokens=int(usage.get("completion_tokens", 0)),
        )
        if self.use_cache:
            _cache_write(cache_file, resp)
        return resp


class OumiProvider(OpenAICompatProvider):
    """Oumi Iris policy decision model adapter (OpenAI-compatible endpoint with SHA-256 disk cache)."""

    def __init__(
        self,
        model: str | None = None,
        base_url: str | None = None,
        api_key_env: str = "OUMI_API_KEY",
    ) -> None:
        resolved_model = model or os.getenv("OUMI_MODEL", "oumi-iris-decision")
        resolved_url = base_url or os.getenv("OUMI_BASE_URL", "https://api.oumi.ai/v1")
        super().__init__(model=resolved_model, base_url=resolved_url, api_key_env=api_key_env)



def format_assistant_turn(resp: LLMResponse) -> dict[str, Any]:
    """Build an Anthropic-compatible assistant message containing text + tool_use blocks."""
    blocks: list[dict[str, Any]] = []
    if resp.text:
        blocks.append({"type": "text", "text": resp.text})
    for c in resp.tool_calls:
        blocks.append({"type": "tool_use", "id": c.id, "name": c.name, "input": c.args})
    return {"role": "assistant", "content": blocks or [{"type": "text", "text": "(no output)"}]}


def format_tool_results_turn(results: list[tuple[ToolCall, str, bool]]) -> dict[str, Any]:
    """Build an Anthropic-compatible user message containing tool_result blocks."""
    return {
        "role": "user",
        "content": [
            {
                "type": "tool_result",
                "tool_use_id": call.id,
                "content": payload_json,
                "is_error": not ok,
            }
            for call, payload_json, ok in results
        ],
    }


def get_provider() -> LLMProvider:
    kind = os.getenv("LLM_PROVIDER", "fake").strip().lower()
    if kind == "fake":
        return FakeProvider()
    if kind == "anthropic":
        return AnthropicProvider(os.getenv("LLM_MODEL", "claude-sonnet-4-5"))
    if kind == "gemini":
        model = os.getenv("GEMINI_MODEL") or os.getenv("LLM_MODEL") or "gemini-3.8-flash"
        if model.startswith("claude-"):
            model = "gemini-3.8-flash"
        return GeminiProvider(model)
    if kind == "groq":
        return OpenAICompatProvider(
            model=os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"),
            base_url=os.getenv("OPENAI_BASE_URL", "https://api.groq.com/openai/v1"),
            api_key_env="GROQ_API_KEY",
        )
    if kind == "grok":
        return OpenAICompatProvider(
            model=os.getenv("GROK_MODEL", "grok-3-mini"),
            base_url=os.getenv("OPENAI_BASE_URL", "https://api.x.ai/v1"),
            api_key_env="XAI_API_KEY",
        )
    if kind == "oumi":
        return OumiProvider()
    if kind == "openai":
        model = os.getenv("OPENAI_MODEL") or os.getenv("LLM_MODEL") or "gpt-4o-mini"
        if model.startswith("claude-"):
            model = "gpt-4o-mini"
        return OpenAICompatProvider(
            model=model,
            base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            api_key_env="OPENAI_API_KEY",
        )
    raise ValueError(f"Unknown LLM_PROVIDER={kind}")
