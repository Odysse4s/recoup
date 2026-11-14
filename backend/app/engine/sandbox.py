"""AST static analyzer and isolated subprocess sandbox for synthesized Python tools.

Synthesized tools are strictly pure Python functions (`mutating=False`, `reversible=True`).
"""
from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from .env import Env
from .tools import REGISTRY, Tool

ALLOWED_IMPORTS = {
    "__future__",
    "functools",
    "fractions",
    "dataclasses",
    "enum",
    "hashlib",
    "hmac",
    "base64",
    "uuid",
    "string",
    "textwrap",
    "difflib",
    "bisect",
    "heapq",
    "copy",
    "urllib",
    "urllib.parse",
    "json",
    "re",
    "math",
    "datetime",
    "csv",
    "statistics",
    "collections",
    "itertools",
    "decimal",
    "unicodedata",
    "typing",
}
FORBIDDEN_ATTRS = {
    "urlopen",
    "urlretrieve",
    "Request",
    "open",
    "FileIO",
    "BufferedReader",
    "BufferedWriter",
    "attrgetter",
    "itemgetter",
    "methodcaller",
    "system",
    "popen",
}
FORBIDDEN_CALLS = {
    "open",
    "exec",
    "eval",
    "compile",
    "__import__",
    "input",
    "breakpoint",
    "globals",
    "locals",
    "vars",
    "getattr",
    "setattr",
    "delattr",
}


def validate_ast(code: str, func_name: str) -> tuple[bool, list[str]]:
    """Static AST check: allowlisted stdlib imports only, no dangerous builtins or dunder access."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return False, [f"SyntaxError: {e}"]

    errors: list[str] = []
    has_func = False
    allowed = ALLOWED_IMPORTS | ({"io"} if func_name == "parse_csv_row" else set())

    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == func_name:
            has_func = True
        elif isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if (alias.name not in allowed and root not in allowed) or (
                    root == "urllib" and alias.name not in ("urllib", "urllib.parse")
                ):
                    errors.append(f"Disallowed import: {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            root = mod.split(".")[0]
            if (mod not in allowed and root not in allowed) or (
                root == "urllib" and mod not in ("urllib", "urllib.parse")
            ):
                errors.append(f"Disallowed import from: {node.module}")
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_CALLS:
                errors.append(f"Forbidden call: {node.func.id}()")
            elif isinstance(node.func, ast.Attribute) and node.func.attr in FORBIDDEN_CALLS:
                errors.append(f"Forbidden call: {node.func.attr}()")
        elif isinstance(node, ast.Name):
            if node.id.startswith("__") and node.id != "__name__":
                errors.append(f"Forbidden dunder name: {node.id}")
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("__"):
                errors.append(f"Forbidden dunder attribute access: {node.attr}")
            elif node.attr in FORBIDDEN_ATTRS:
                errors.append(f"Forbidden attribute access: {node.attr}")

    if not has_func:
        errors.append(f"Missing top-level function `def {func_name}(args: dict)`")

    return len(errors) == 0, errors


_ALLOWED_IMPORTS_REPR = repr(sorted(ALLOWED_IMPORTS | {"io"}))

_RUNNER = f"""
import json, sys
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
except Exception:
    pass

import builtins
safe_builtins = dict(builtins.__dict__)
for _bad in ("open", "exec", "eval", "compile", "breakpoint", "input"):
    safe_builtins.pop(_bad, None)

_allowed = set({_ALLOWED_IMPORTS_REPR})
_orig_import = builtins.__import__
def _restricted_import(name, *args, **kwargs):
    root = name.split(".")[0]
    if root not in _allowed and name not in _allowed:
        raise ImportError(f"Disallowed import: {{name}}")
    return _orig_import(name, *args, **kwargs)

safe_builtins["__import__"] = _restricted_import

payload = json.loads(sys.stdin.read())
real_stdout = sys.stdout
sys.stdout = sys.stderr
try:
    ns = {{"__builtins__": safe_builtins}}
    exec(payload["code"], ns)
    fn = ns[payload["func_name"]]
    out = fn(payload["args"])
finally:
    sys.stdout = real_stdout
real_stdout.write(json.dumps({{"ok": True, "output": out}}))
"""


def _sandbox_env() -> dict[str, str]:
    """Strip secrets and API keys while preserving minimum OS variables needed to start Python."""
    keep = ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME")
    return {k: os.environ[k] for k in keep if k in os.environ}


def run_in_sandbox(code: str, func_name: str, args: dict[str, Any], timeout: float = 3.0) -> dict[str, Any]:
    ok, errors = validate_ast(code, func_name)
    if not ok:
        return {"ok": False, "error": "; ".join(errors)}
    try:
        with tempfile.TemporaryDirectory() as tmp_cwd:
            proc = subprocess.run(
                [sys.executable, "-I", "-c", _RUNNER],
                input=json.dumps({"code": code, "func_name": func_name, "args": args}),
                capture_output=True,
                text=True,
                timeout=timeout,
                env=_sandbox_env(),
                cwd=tmp_cwd,
                check=False,
            )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"Sandbox timeout ({timeout}s)"}
    if proc.returncode != 0:
        return {"ok": False, "error": proc.stderr.strip() or f"Exited with {proc.returncode}"}
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"Non-JSON output: {proc.stdout[:200]}"}


def verify_and_register_forged_tool(
    name: str,
    description: str,
    params_schema: dict[str, Any],
    code: str,
    examples: list[dict[str, Any]],
    save_dir: Path | None = None,
) -> dict[str, Any]:
    """Validate AST, run all TDD examples in subprocess sandbox, and register into REGISTRY if all pass."""
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$", name):
        return {
            "name": name,
            "ast_passed": False,
            "ast_errors": [f"Invalid tool identifier: {name!r}"],
            "test_results": [],
            "registered": False,
        }
    if save_dir:
        target_file = (save_dir / f"{name}.py").resolve()
        if not target_file.is_relative_to(save_dir.resolve()):
            return {
                "name": name,
                "ast_passed": False,
                "ast_errors": [f"Tool file path escapes save directory: {name!r}"],
                "test_results": [],
                "registered": False,
            }
    ast_ok, ast_errors = validate_ast(code, name)
    results: list[dict[str, Any]] = []
    if not examples:
        return {
            "name": name,
            "ast_passed": ast_ok,
            "ast_errors": ast_errors + ["At least one input/output test example is required"],
            "test_results": results,
            "registered": False,
        }
    all_passed = ast_ok

    if ast_ok:
        for idx, ex in enumerate(examples):
            res = run_in_sandbox(code, name, ex["in"])
            passed = res.get("ok", False) and res.get("output") == ex["out"]
            all_passed = all_passed and passed
            results.append(
                {
                    "index": idx,
                    "passed": passed,
                    "actual": res.get("output") if res.get("ok") else res.get("error"),
                }
            )

    if all_passed:
        if save_dir:
            save_dir.mkdir(parents=True, exist_ok=True)
            (save_dir / f"{name}.py").write_text(code, encoding="utf-8")
        REGISTRY[name] = ForgedTool(name=name, description=description, params_schema=params_schema, code=code)

    return {
        "name": name,
        "ast_passed": ast_ok,
        "ast_errors": ast_errors,
        "test_results": results,
        "registered": all_passed,
    }


class ForgedTool(Tool):
    """Pure sandboxed tool synthesized at runtime."""

    risk = "low"
    reversible = True
    mutating = False
    source = "forged"

    def __init__(self, name: str, description: str, params_schema: dict[str, Any], code: str) -> None:
        super().__init__()
        self.name = name  # type: ignore[misc]
        self.description = description  # type: ignore[misc]
        self.params_schema = params_schema  # type: ignore[misc]
        self.code = code
        self.sha256 = hashlib.sha256(code.encode("utf-8")).hexdigest()

    def preview(self, args: dict[str, Any], env: Env) -> str:
        return self.code

    def do(self, args: dict[str, Any], env: Env) -> dict[str, Any]:
        if hashlib.sha256(self.code.encode("utf-8")).hexdigest() != self.sha256:
            raise RuntimeError("ForgedTool code integrity check failed (SHA-256 mismatch)")
        res = run_in_sandbox(self.code, self.name, args)
        if not res.get("ok"):
            raise RuntimeError(res.get("error", "forged tool failed"))
        return {"result": res["output"]}

    def undo(self, receipt: dict[str, Any], env: Env) -> None:
        return None
