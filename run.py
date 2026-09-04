"""SABOR - ponto de entrada.

Sobe o servidor local em uma thread e abre o painel do host em uma janela
pywebview. O executavel e o servidor: os convidados so recebem um link.
"""

from __future__ import annotations

import atexit
import ctypes
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path


def _dotnet_desktop_runtime_installed() -> bool:
    """O painel roda em pythonnet (Python.NET), que precisa do .NET Desktop
    Runtime de verdade instalado — o .NET Framework que já vem no Windows
    NAO basta a partir do pythonnet 3.x, e o instalador do WebView2 nao
    instala isso sozinho. Sem essa checagem o app quebra com um traceback do
    Python em vez de dizer o que falta.

    Confere pela pasta em vez de registro: mais simples e cobre tanto o
    instalador MSI quanto o "instalador de features" que o winget usa.
    """
    base = os.environ.get("ProgramW6432") or os.environ.get("ProgramFiles") or r"C:\Program Files"
    shared = Path(base) / "dotnet" / "shared" / "Microsoft.WindowsDesktop.App"
    try:
        return shared.is_dir() and any(shared.iterdir())
    except OSError:
        return False


if sys.platform == "win32" and not _dotnet_desktop_runtime_installed():
    ctypes.windll.user32.MessageBoxW(
        None,
        "O Sabor DC precisa do .NET Desktop Runtime da Microsoft, que não foi "
        "encontrado nesta máquina — é diferente do .NET Framework que já vem "
        "no Windows.\n\n"
        "Instale com:\n"
        "winget install Microsoft.DotNet.DesktopRuntime.8\n\n"
        "ou baixe em dotnet.microsoft.com/download/dotnet/8.0 "
        "(escolha \"Desktop Runtime\", x64) e rode o Sabor DC de novo.",
        "Sabor DC — falta um componente",
        0x10,  # MB_ICONERROR
    )
    raise SystemExit(1)

# Precisa vir antes de importar webview: e assim que o WebView2 recebe flags.
_args = ["--autoplay-policy=no-user-gesture-required"]
if os.environ.get("SABOR_AUTOSELECT"):
    # Plano B: alguns builds do WebView2 nao abrem o seletor de tela.
    _args.append("--auto-select-desktop-capture-source=Entire screen")
os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = " ".join(
    filter(None, [os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", ""), *_args])
).strip()

import webview  # noqa: E402

from sabor import APP_NAME, __version__  # noqa: E402
from sabor.api import Api  # noqa: E402
from sabor.config import DATA_DIR, Settings  # noqa: E402
from sabor.net import free_port  # noqa: E402
from sabor.server import Server  # noqa: E402


def wait_for_server(port: int, timeout: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/api/health"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.12)
    return False


def main() -> int:
    settings = Settings.load()
    settings.http_port = free_port(settings.http_port)
    settings.https_port = free_port(max(settings.https_port, settings.http_port + 1))

    server = Server(settings)
    api = Api(server)
    server.room.on_change = api.notify_room

    threading.Thread(target=server.run_forever, name="sabor-server", daemon=True).start()
    if not wait_for_server(server.http_port):
        print("[sabor] o servidor local nao subiu a tempo.", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{server.http_port}/host?k={server.host_token}"
    window = webview.create_window(
        f"{APP_NAME} {__version__}",
        url,
        js_api=api,
        width=1180,
        height=760,
        min_size=(940, 620),
        frameless=True,
        easy_drag=False,
        background_color="#0B0B0F",
    )
    api._window = window
    # Se o app cair, o cloudflared nao pode ficar orfao tunelando uma porta morta.
    atexit.register(api.shutdown)

    def on_start() -> None:
        if settings.auto_tunnel:
            api.start_tunnel()

    webview.start(
        on_start,
        private_mode=False,
        storage_path=str(DATA_DIR / "webview"),
        debug=bool(os.environ.get("SABOR_DEBUG")),
    )
    api.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
