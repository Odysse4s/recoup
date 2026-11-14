"""AST static analyzer and isolated subprocess sandbox for synthesized Python tools.

Synthesized tools are strictly pure Python functions (`mutating=False`, `reversible=True`).
"""

from __future__ import annotations

import ast
import builtins
import contextlib
import hashlib
import json
import keyword
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import IO, Any

from .env import Env
from .tools import REGISTRY, Tool

MAX_CODE_CHARS = 16_384
MAX_AST_NODES = 1_000
STDOUT_CAP_BYTES = 262_144  # 256 KiB
STDERR_CAP_BYTES = 65_536  # 64 KiB

_FUNC_NAME_RE = re.compile(r"\A[a-zA-Z_][a-zA-Z0-9_]{0,63}\Z")
_BUILTIN_NAMES = frozenset(dir(builtins))

ALLOWED_IMPORTS = {
    "__future__",
    "io",
    "functools",
    "operator",
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
    "urllib.parse",
    "json",
    "re",
    "math",
    "datetime",
    "csv",
    "statistics",
    "collections",
    "collections.abc",
    "itertools",
    "decimal",
    "unicodedata",
    "typing",
}

FORBIDDEN_NAMES = {
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
    "dir",
    "getattr",
    "setattr",
    "delattr",
    "memoryview",
    "help",
    "exit",
    "quit",
    "type",
    "super",
    "classmethod",
    "staticmethod",
    "property",
}
FORBIDDEN_CALLS = FORBIDDEN_NAMES

FORBIDDEN_ATTRS = {
    "open",
    "open_code",
    "FileIO",
    "RawIOBase",
    "BufferedReader",
    "BufferedWriter",
    "BufferedRandom",
    "TextIOWrapper",
    "urlopen",
    "urlretrieve",
    "Request",
    "attrgetter",
    "methodcaller",
    "format",
    "format_map",
    "Formatter",
    "gi_frame",
    "gi_code",
    "gi_yieldfrom",
    "cr_frame",
    "cr_code",
    "cr_await",
    "ag_frame",
    "ag_code",
    "ag_await",
    "tb_frame",
    "tb_next",
    "f_back",
    "f_builtins",
    "f_globals",
    "f_locals",
    "f_code",
    "co_consts",
    "co_code",
    "mro",
    "subclasses",
    "system",
    "popen",
    "os",
    "sys",
    "bltns",
    "builtins",
    "subprocess",
}

_DISALLOWED_IMPORTED_SYMBOLS = frozenset(
    {
        "os",
        "sys",
        "builtins",
        "bltns",
        "subprocess",
        "socket",
        "shutil",
        "pathlib",
        "ctypes",
        "importlib",
        "inspect",
        "types",
        "evaluate_forward_ref",
        "get_type_hints",
        "FunctionType",
        "MethodType",
        "make_dataclass",
    }
)

_TYPE_PARAM_TYPES = tuple(
    t
    for t in (
        getattr(ast, "TypeVar", None),
        getattr(ast, "ParamSpec", None),
        getattr(ast, "TypeVarTuple", None),
    )
    if t is not None
)


def _check_tool_identifier(name: str, *, reject_all_builtins: bool = False) -> list[str]:
    if not isinstance(name, str) or not _FUNC_NAME_RE.fullmatch(name):
        return [f"Invalid tool identifier: {name!r}"]
    errs: list[str] = []
    if "__" in name:
        errs.append(f"Forbidden dunder function name: {name}")
    if keyword.iskeyword(name) or keyword.issoftkeyword(name):
        errs.append(f"Reserved Python keyword cannot be used as tool name: {name}")
    if name in FORBIDDEN_NAMES or (reject_all_builtins and name in _BUILTIN_NAMES):
        errs.append(f"Forbidden builtin name cannot be used as tool name: {name}")
    return errs


def validate_ast(code: str, func_name: str) -> tuple[bool, list[str]]:
    """Static AST check: allowlisted stdlib imports only, no dangerous builtins, aliases, or dunder access."""
    name_errors = _check_tool_identifier(func_name, reject_all_builtins=False)
    if name_errors:
        return False, name_errors

    if not isinstance(code, str):
        return False, ["Code payload must be a string"]
    if len(code) > MAX_CODE_CHARS:
        return False, [f"Code length exceeds limit ({MAX_CODE_CHARS} chars)"]

    try:
        tree = ast.parse(code, mode="exec")
    except (SyntaxError, ValueError, RecursionError, MemoryError) as exc:
        return False, [f"{type(exc).__name__}: {exc}"]

    for node_count, _ in enumerate(ast.walk(tree), start=1):
        if node_count > MAX_AST_NODES:
            return False, [f"AST node count exceeds limit ({MAX_AST_NODES} nodes)"]

    errors: list[str] = []
    has_func = any(isinstance(stmt, ast.FunctionDef) and stmt.name == func_name for stmt in tree.body)

    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            errors.append(f"Class definitions are disallowed: {node.name}")
        elif isinstance(node, ast.AsyncFunctionDef):
            errors.append(f"Async functions are disallowed: {node.name}")
            if "__" in node.name:
                errors.append(f"Forbidden dunder function name: {node.name}")
            if node.decorator_list:
                errors.append(f"Decorators are disallowed on function: {node.name}")
        elif isinstance(node, ast.FunctionDef):
            if "__" in node.name:
                errors.append(f"Forbidden dunder function name: {node.name}")
            if node.name in FORBIDDEN_NAMES:
                errors.append(f"Forbidden function name: {node.name}")
            if node.decorator_list:
                errors.append(f"Decorators are disallowed on function: {node.name}")
        elif isinstance(node, (ast.Await, ast.AsyncFor, ast.AsyncWith)):
            errors.append("Async/await constructs are disallowed")
        elif isinstance(node, (ast.Yield, ast.YieldFrom)):
            errors.append("Generator yield constructs are disallowed")
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            errors.append("Global and nonlocal statements are disallowed")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name not in ALLOWED_IMPORTS:
                    errors.append(f"Disallowed import: {alias.name}")
                if alias.asname:
                    if "__" in alias.asname:
                        errors.append(f"Forbidden dunder alias: {alias.asname}")
                    if alias.asname in FORBIDDEN_NAMES or alias.asname in FORBIDDEN_ATTRS:
                        errors.append(f"Forbidden import alias: {alias.asname}")
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if node.level and node.level > 0:
                errors.append(f"Disallowed import: {'.' * node.level}{mod}")
            elif mod == "urllib":
                for alias in node.names:
                    if alias.name != "parse":
                        errors.append(f"Disallowed import: urllib.{alias.name}")
            elif mod not in ALLOWED_IMPORTS:
                errors.append(f"Disallowed import: {mod}")

            for alias in node.names:
                if alias.name == "*":
                    errors.append(f"Disallowed import: {mod}.*")
                elif "__" in alias.name:
                    errors.append(f"Forbidden dunder import: {alias.name}")
                elif (
                    alias.name in FORBIDDEN_NAMES
                    or alias.name in FORBIDDEN_ATTRS
                    or alias.name in _DISALLOWED_IMPORTED_SYMBOLS
                ):
                    errors.append(f"Forbidden imported symbol: {alias.name}")
                if alias.asname:
                    if "__" in alias.asname:
                        errors.append(f"Forbidden dunder alias: {alias.asname}")
                    if alias.asname in FORBIDDEN_NAMES or alias.asname in FORBIDDEN_ATTRS:
                        errors.append(f"Forbidden import alias: {alias.asname}")
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_CALLS:
                errors.append(f"Forbidden call: {node.func.id}()")
            elif isinstance(node.func, ast.Attribute) and node.func.attr in FORBIDDEN_CALLS:
                errors.append(f"Forbidden call: {node.func.attr}()")
        elif isinstance(node, ast.Name):
            if "__" in node.id and node.id != "__name__":
                errors.append(f"Forbidden dunder name: {node.id}")
            if node.id in FORBIDDEN_NAMES:
                errors.append(f"Forbidden name: {node.id}")
        elif isinstance(node, ast.Attribute):
            if "__" in node.attr:
                errors.append(f"Forbidden dunder attribute access: {node.attr}")
            elif node.attr in FORBIDDEN_ATTRS:
                errors.append(f"Forbidden attribute access: {node.attr}")
        elif isinstance(node, ast.arg):
            if "__" in node.arg:
                errors.append(f"Forbidden dunder parameter: {node.arg}")
            if node.arg in FORBIDDEN_NAMES:
                errors.append(f"Forbidden parameter name: {node.arg}")
        elif isinstance(node, ast.MatchClass):
            for kw_attr in node.kwd_attrs:
                if "__" in kw_attr:
                    errors.append(f"Forbidden dunder attribute access: {kw_attr}")
                elif kw_attr in FORBIDDEN_ATTRS:
                    errors.append(f"Forbidden attribute access: {kw_attr}")
        elif isinstance(node, (ast.MatchAs, ast.MatchStar, ast.ExceptHandler)):
            bound_name = node.name
            if isinstance(bound_name, str):
                if "__" in bound_name:
                    errors.append(f"Forbidden dunder name: {bound_name}")
                if bound_name in FORBIDDEN_NAMES:
                    errors.append(f"Forbidden name: {bound_name}")
        elif isinstance(node, ast.MatchMapping):
            if isinstance(node.rest, str):
                if "__" in node.rest:
                    errors.append(f"Forbidden dunder name: {node.rest}")
                if node.rest in FORBIDDEN_NAMES:
                    errors.append(f"Forbidden name: {node.rest}")
        elif _TYPE_PARAM_TYPES and isinstance(node, _TYPE_PARAM_TYPES):
            tp_name = getattr(node, "name", None)
            if isinstance(tp_name, str):
                if "__" in tp_name:
                    errors.append(f"Forbidden dunder name: {tp_name}")
                if tp_name in FORBIDDEN_NAMES:
                    errors.append(f"Forbidden name: {tp_name}")

    if not has_func:
        errors.append(f"Missing top-level function `def {func_name}(args: dict)`")

    return len(errors) == 0, errors


_RUNNER = """
def _recoup_main():
    import builtins as _builtins
    import json as _json
    import sys as _sys
    import types as _types

    _sys.set_int_max_str_digits(4300)

    try:
        import resource as _resource

        def _clamp(res_id, soft_req, hard_req):
            try:
                _cur_soft, _cur_hard = _resource.getrlimit(res_id)
                if _cur_hard != _resource.RLIM_INFINITY and _cur_hard >= 0:
                    hard_val = min(hard_req, _cur_hard)
                    soft_val = min(soft_req, hard_val)
                else:
                    soft_val, hard_val = soft_req, hard_req
                _resource.setrlimit(res_id, (soft_val, hard_val))
            except (ValueError, OSError):
                pass

        _clamp(_resource.RLIMIT_CPU, 2, 2)
        _clamp(_resource.RLIMIT_FSIZE, 0, 0)
        _clamp(_resource.RLIMIT_NOFILE, 32, 32)
        _clamp(_resource.RLIMIT_AS, 768 * 1024 * 1024, 768 * 1024 * 1024)
    except ImportError:
        pass

    _real_import = _builtins.__import__
    _real_stdout = _sys.stdout
    _real_stderr = _sys.stderr

    _ALLOWED_IMPORTS = {
        "__future__",
        "io",
        "functools",
        "operator",
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
        "urllib.parse",
        "json",
        "re",
        "math",
        "datetime",
        "csv",
        "statistics",
        "collections",
        "collections.abc",
        "itertools",
        "decimal",
        "unicodedata",
        "typing",
    }

    _IO_SAFE_EXPORTS = (
        "StringIO",
        "BytesIO",
        "TextIOBase",
        "BufferedIOBase",
        "IOBase",
        "SEEK_SET",
        "SEEK_CUR",
        "SEEK_END",
    )

    _PROXY_OMIT = {
        "open",
        "open_code",
        "FileIO",
        "RawIOBase",
        "BufferedReader",
        "BufferedWriter",
        "BufferedRandom",
        "TextIOWrapper",
        "urlopen",
        "urlretrieve",
        "Request",
        "attrgetter",
        "methodcaller",
        "Formatter",
        "evaluate_forward_ref",
        "get_type_hints",
        "FunctionType",
        "MethodType",
        "make_dataclass",
        "main",
        "system",
        "popen",
        "os",
        "sys",
        "builtins",
        "bltns",
        "subprocess",
        "socket",
        "shutil",
        "pathlib",
        "ctypes",
        "importlib",
        "inspect",
        "types",
    }

    _proxy_cache = {}

    def _build_sanitized_proxy(mod_name, real_mod):
        if mod_name in _proxy_cache:
            return _proxy_cache[mod_name]
        proxy = _types.ModuleType(mod_name)
        if mod_name == "io":
            for attr in _IO_SAFE_EXPORTS:
                if hasattr(real_mod, attr):
                    setattr(proxy, attr, getattr(real_mod, attr))
        else:
            for attr in dir(real_mod):
                if attr.startswith("_") or attr in _PROXY_OMIT:
                    continue
                val = getattr(real_mod, attr)
                if isinstance(val, _types.ModuleType):
                    continue
                setattr(proxy, attr, val)
        _proxy_cache[mod_name] = proxy
        return proxy

    def _validate_fromlist(mod_name, fromlist):
        if not fromlist:
            return
        for item in fromlist:
            if not isinstance(item, str) or item == "*" or "__" in item or item in _PROXY_OMIT:
                raise ImportError(f"Disallowed symbol import {item!r} from {mod_name}")

    def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level != 0:
            raise ImportError("Relative imports are disallowed in sandbox")
        if not isinstance(name, str):
            raise ImportError("Invalid module name")

        if name == "urllib":
            if not fromlist or any(item != "parse" for item in fromlist):
                raise ImportError("Disallowed import: urllib")
            real_up = _real_import("urllib.parse", None, None, ("*",), 0)
            up_proxy = _build_sanitized_proxy("urllib.parse", real_up)
            urllib_pkg = _proxy_cache.get("urllib")
            if urllib_pkg is None:
                urllib_pkg = _types.ModuleType("urllib")
                urllib_pkg.parse = up_proxy
                _proxy_cache["urllib"] = urllib_pkg
            return urllib_pkg

        if name == "urllib.parse":
            _validate_fromlist(name, fromlist)
            real_up = _real_import("urllib.parse", None, None, ("*",), 0)
            up_proxy = _build_sanitized_proxy("urllib.parse", real_up)
            if fromlist:
                return up_proxy
            urllib_pkg = _proxy_cache.get("urllib")
            if urllib_pkg is None:
                urllib_pkg = _types.ModuleType("urllib")
                urllib_pkg.parse = up_proxy
                _proxy_cache["urllib"] = urllib_pkg
            return urllib_pkg

        if name.startswith("urllib."):
            raise ImportError(f"Disallowed import: {name}")

        if name not in _ALLOWED_IMPORTS:
            raise ImportError(f"Disallowed import: {name}")

        _validate_fromlist(name, fromlist)

        if name == "collections.abc":
            real_cabc = _real_import("collections.abc", None, None, ("*",), 0)
            cabc_proxy = _build_sanitized_proxy("collections.abc", real_cabc)
            if fromlist:
                return cabc_proxy
            real_coll = _real_import("collections", None, None, ("*",), 0)
            coll_proxy = _build_sanitized_proxy("collections", real_coll)
            coll_proxy.abc = cabc_proxy
            return coll_proxy

        if name == "collections":
            real_coll = _real_import("collections", None, None, ("*",), 0)
            coll_proxy = _build_sanitized_proxy("collections", real_coll)
            if fromlist and "abc" in fromlist:
                real_cabc = _real_import("collections.abc", None, None, ("*",), 0)
                coll_proxy.abc = _build_sanitized_proxy("collections.abc", real_cabc)
            return coll_proxy

        real_mod = _real_import(name, None, None, ("*",), 0)
        return _build_sanitized_proxy(name, real_mod)

    def _safe_print(*args, sep=" ", end="\\n", flush=False):
        text = sep.join(str(a) for a in args) + end
        _real_stderr.write(text)
        if flush:
            _real_stderr.flush()

    _SAFE_BUILTIN_NAMES = (
        "abs",
        "all",
        "any",
        "ascii",
        "bin",
        "bool",
        "bytearray",
        "bytes",
        "callable",
        "chr",
        "complex",
        "dict",
        "divmod",
        "enumerate",
        "filter",
        "float",
        "format",
        "frozenset",
        "hash",
        "hex",
        "int",
        "isinstance",
        "issubclass",
        "iter",
        "len",
        "list",
        "map",
        "max",
        "min",
        "next",
        "object",
        "oct",
        "ord",
        "pow",
        "range",
        "repr",
        "reversed",
        "round",
        "set",
        "slice",
        "sorted",
        "str",
        "sum",
        "tuple",
        "zip",
        "ArithmeticError",
        "AssertionError",
        "AttributeError",
        "EOFError",
        "Exception",
        "FloatingPointError",
        "ImportError",
        "IndexError",
        "KeyError",
        "LookupError",
        "MemoryError",
        "NameError",
        "NotImplementedError",
        "OverflowError",
        "RuntimeError",
        "StopIteration",
        "SyntaxError",
        "TypeError",
        "UnicodeDecodeError",
        "UnicodeEncodeError",
        "UnicodeError",
        "ValueError",
        "ZeroDivisionError",
    )

    SAFE_BUILTINS = {k: getattr(_builtins, k) for k in _SAFE_BUILTIN_NAMES}
    SAFE_BUILTINS["True"] = True
    SAFE_BUILTINS["False"] = False
    SAFE_BUILTINS["None"] = None
    SAFE_BUILTINS["Ellipsis"] = Ellipsis
    SAFE_BUILTINS["NotImplemented"] = NotImplemented
    SAFE_BUILTINS["print"] = _safe_print
    SAFE_BUILTINS["__import__"] = _safe_import

    def _run_isolated(code_str, fn_name, call_args):
        compiled = _builtins.compile(code_str, "<forged>", "exec")
        ns = {"__builtins__": SAFE_BUILTINS, "__name__": "__forged__"}
        _builtins.exec(compiled, ns, ns)
        fn = ns.get(fn_name)
        if not callable(fn):
            raise RuntimeError(f"Target `{fn_name}` is missing or not callable")
        return fn(call_args)

    payload = _json.loads(_sys.stdin.read())
    _sys.stdout = _real_stderr
    try:
        out = _run_isolated(payload["code"], payload["func_name"], payload["args"])
    finally:
        _sys.stdout = _real_stdout

    _real_stdout.write(_json.dumps({"ok": True, "output": out}))
    _real_stdout.flush()


_recoup_main()
"""


def _sandbox_env() -> dict[str, str]:
    """Strip secrets and API keys, preserving only minimum OS loader variables needed to start Python."""
    keep = ("PATH", "SYSTEMROOT", "WINDIR")
    return {k: os.environ[k] for k in keep if k in os.environ}


def _drain_pipe(stream: IO[bytes] | None, cap_bytes: int, sink: list[Any]) -> None:
    """Read from `stream` until EOF, buffering at most `cap_bytes` and discarding any excess."""
    if stream is None:
        sink.extend((b"", False))
        return
    chunks: list[bytes] = []
    buffered = 0
    overflowed = False
    try:
        while True:
            chunk = stream.read(16_384)
            if not chunk:
                break
            if not overflowed:
                remaining = cap_bytes - buffered
                if len(chunk) <= remaining:
                    chunks.append(chunk)
                    buffered += len(chunk)
                else:
                    if remaining > 0:
                        chunks.append(chunk[:remaining])
                    overflowed = True
    except OSError:
        pass
    finally:
        with contextlib.suppress(OSError):
            stream.close()
    sink.extend((b"".join(chunks), overflowed))


def _write_stdin(stream: IO[bytes] | None, data: bytes) -> None:
    if stream is None:
        return
    try:
        stream.write(data)
        stream.flush()
    except (BrokenPipeError, OSError):
        pass
    finally:
        with contextlib.suppress(OSError):
            stream.close()


def _kill_process_group(proc: subprocess.Popen[bytes]) -> None:
    if hasattr(os, "killpg"):
        with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
            os.killpg(proc.pid, signal.SIGKILL)
    else:
        with contextlib.suppress(ProcessLookupError, OSError):
            proc.kill()


def run_in_sandbox(code: str, func_name: str, args: dict[str, Any], timeout: float = 3.0) -> dict[str, Any]:
    ok, errors = validate_ast(code, func_name)
    if not ok:
        return {"ok": False, "error": "; ".join(errors)}
    if not isinstance(args, dict):
        return {"ok": False, "error": "Sandbox `args` must be a dict"}
    try:
        payload_bytes = json.dumps({"code": code, "func_name": func_name, "args": args}).encode("utf-8")
    except (TypeError, ValueError) as exc:
        return {"ok": False, "error": f"Non-JSON-serializable sandbox input: {exc}"}

    out_sink: list[Any] = []
    err_sink: list[Any] = []
    timed_out = False

    with tempfile.TemporaryDirectory(prefix="recoup_sbx_") as tmp_cwd:
        proc = subprocess.Popen(
            [sys.executable, "-I", "-S", "-B", "-c", _RUNNER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            cwd=tmp_cwd,
            env=_sandbox_env(),
        )
        t_out = threading.Thread(
            target=_drain_pipe, args=(proc.stdout, STDOUT_CAP_BYTES, out_sink), daemon=True
        )
        t_err = threading.Thread(
            target=_drain_pipe, args=(proc.stderr, STDERR_CAP_BYTES, err_sink), daemon=True
        )
        t_in = threading.Thread(target=_write_stdin, args=(proc.stdin, payload_bytes), daemon=True)
        t_out.start()
        t_err.start()
        t_in.start()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_process_group(proc)
        finally:
            _kill_process_group(proc)
            with contextlib.suppress(OSError):
                proc.wait()
            t_in.join(timeout=1.0)
            t_out.join(timeout=1.0)
            t_err.join(timeout=1.0)

    if timed_out:
        return {"ok": False, "error": f"Sandbox timeout ({timeout}s)"}

    stdout_bytes: bytes = out_sink[0] if len(out_sink) >= 2 else b""
    stdout_overflowed: bool = bool(out_sink[1]) if len(out_sink) >= 2 else False
    stderr_bytes: bytes = err_sink[0] if len(err_sink) >= 2 else b""

    if stdout_overflowed:
        return {"ok": False, "error": "Sandbox stdout limit exceeded (256 KiB)"}

    if proc.returncode != 0:
        err_text = stderr_bytes.decode("utf-8", errors="replace").strip()
        return {"ok": False, "error": err_text or f"Exited with {proc.returncode}"}

    stdout_text = stdout_bytes.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(stdout_text)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"Non-JSON output: {stdout_text[:200]}"}
    if not isinstance(parsed, dict) or "ok" not in parsed:
        return {"ok": False, "error": f"Malformed sandbox output: {stdout_text[:200]}"}
    return parsed


def _precheck_save_dir(save_dir: Path, name: str) -> str | None:
    """Validate `save_dir` and target path before running examples (without creating directories)."""
    if save_dir.is_symlink():
        return f"Refusing symlinked save_dir: {save_dir}"
    target = save_dir / f"{name}.py"
    if target.is_symlink():
        return f"Refusing symlink target file: {target}"
    try:
        if not target.resolve().is_relative_to(save_dir.resolve()):
            return f"Tool file path escapes save directory: {name!r}"
    except OSError as exc:
        return f"Unsafe save_dir path: {exc}"
    return None


def _atomic_write_nofollow(save_dir: Path, name: str, code: str) -> str | None:
    """Safely write `code` to `save_dir / f'{name}.py'` without following symlinks."""
    if save_dir.is_symlink():
        return f"Refusing symlinked save_dir: {save_dir}"
    try:
        save_dir.mkdir(parents=True, exist_ok=True)
        if save_dir.is_symlink() or not save_dir.is_dir():
            return f"Unsafe save_dir after mkdir: {save_dir}"
        resolved_dir = save_dir.resolve(strict=True)
        target = save_dir / f"{name}.py"
        if target.is_symlink():
            return f"Refusing symlink target file: {target}"
        if not target.resolve().is_relative_to(resolved_dir):
            return f"Tool file path escapes save directory: {name!r}"

        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(target, flags, 0o600)
        try:
            st = os.fstat(fd)
            if not os.path.samestat(st, os.lstat(target)):
                return f"Detected file swap on target path: {target}"
            with contextlib.suppress(OSError):
                os.fchmod(fd, 0o600)
            encoded = code.encode("utf-8")
            view = memoryview(encoded)
            written = 0
            while written < len(view):
                written += os.write(fd, view[written:])
        finally:
            os.close(fd)
    except OSError as exc:
        return f"Refusing unsafe save_dir write: {exc}"
    return None


def verify_and_register_forged_tool(
    name: str,
    description: str,
    params_schema: dict[str, Any],
    code: str,
    examples: list[dict[str, Any]],
    save_dir: Path | None = None,
) -> dict[str, Any]:
    """Validate AST, run all TDD examples in subprocess sandbox, and register into REGISTRY if all pass."""
    name_errors = _check_tool_identifier(name, reject_all_builtins=True)
    if name_errors:
        return {
            "name": name,
            "ast_passed": False,
            "ast_errors": name_errors,
            "test_results": [],
            "registered": False,
        }

    if name in REGISTRY and getattr(REGISTRY[name], "source", None) != "forged":
        return {
            "name": name,
            "ast_passed": False,
            "ast_errors": [f"Cannot overwrite built-in or non-forged tool `{name}`"],
            "test_results": [],
            "registered": False,
        }

    if save_dir is not None:
        pre_err = _precheck_save_dir(Path(save_dir), name)
        if pre_err is not None:
            return {
                "name": name,
                "ast_passed": False,
                "ast_errors": [pre_err],
                "test_results": [],
                "registered": False,
            }

    ast_ok, ast_errors = validate_ast(code, name)
    results: list[dict[str, Any]] = []
    if not examples:
        return {
            "name": name,
            "ast_passed": ast_ok,
            "ast_errors": [*ast_errors, "At least one input/output test example is required"],
            "test_results": results,
            "registered": False,
        }
    all_passed = ast_ok

    if ast_ok:
        for idx, ex in enumerate(examples):
            has_io_keys = isinstance(ex, dict) and (
                ("in" in ex and "out" in ex)
                or ("input_args" in ex and "expected_output" in ex)
            )
            in_args = ex.get("in", ex.get("input_args")) if isinstance(ex, dict) else None
            expected_out = ex.get("out") if isinstance(ex, dict) and "out" in ex else (
                ex.get("expected_output") if isinstance(ex, dict) else None
            )
            if not has_io_keys or not isinstance(in_args, dict):
                all_passed = False
                results.append(
                    {
                        "index": idx,
                        "passed": False,
                        "actual": "Invalid example entry: expected {'in': dict, 'out': Any}",
                    }
                )
                continue
            res = run_in_sandbox(code, name, in_args)
            passed = res.get("ok", False) and res.get("output") == expected_out
            all_passed = all_passed and passed
            entry: dict[str, Any] = {
                "index": idx,
                "passed": passed,
                "actual": res.get("output") if res.get("ok") else res.get("error"),
            }
            if not res.get("ok"):
                entry["error"] = res.get("error")
            results.append(entry)

    if all_passed:
        if name in REGISTRY and getattr(REGISTRY[name], "source", None) != "forged":
            return {
                "name": name,
                "ast_passed": False,
                "ast_errors": [f"Cannot overwrite built-in or non-forged tool `{name}`"],
                "test_results": results,
                "registered": False,
            }
        if save_dir is not None:
            write_err = _atomic_write_nofollow(Path(save_dir), name, code)
            if write_err is not None:
                return {
                    "name": name,
                    "ast_passed": False,
                    "ast_errors": [write_err],
                    "test_results": results,
                    "registered": False,
                }
        REGISTRY[name] = ForgedTool(
            name=name, description=description, params_schema=params_schema, code=code
        )

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
