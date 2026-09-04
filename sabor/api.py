"""Ponte entre a pagina do painel e o processo Python (window.pywebview.api).

Todo atributo guardado aqui e prefixado com "_": o pywebview percorre os
atributos publicos do objeto js_api para expo-los ao JavaScript, e guardar a
janela (ou o servidor) sem o prefixo faz ele descer para sempre por
window.native.AccessibilityObject.Bounds.Empty... ate estourar a recursao — e
ai a ponte nunca fica pronta e o painel trava carregando.
"""

from __future__ import annotations

import webbrowser
from dataclasses import asdict
from typing import Any

from .net import Tunnel, dns_report
from .server import Server


class Api:
    def __init__(self, server: Server) -> None:
        self._server = server
        self._settings = server.settings
        self._tunnel = Tunnel(server.http_port)
        self._tunnel.on_ready = lambda: self._push("sabor:tunnel")
        self._window = None  # preenchido pelo run.py

    # -- estado ------------------------------------------------------------
    def state(self) -> dict[str, Any]:
        return {
            "settings": asdict(self._settings),
            "links": self._server.links(self._tunnel.url),
            "tunnel": {
                "available": Tunnel.available(),
                "running": self._tunnel.running,
                "ready": self._tunnel.ready,
                "unconfirmed": self._tunnel.unconfirmed,
                "url": self._tunnel.url,
                "error": self._tunnel.error,
                "dns": self._tunnel.dns,
            },
            "network": {
                "lan": self._server.lan,
                "httpPort": self._server.http_port,
                "httpsPort": self._server.https_port,
            },
            "room": self._server.room.snapshot(),
        }

    def save_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        self._settings.update(patch or {})
        return self.state()

    def rotate_link(self) -> dict[str, Any]:
        self._settings.rotate_link()
        return self.state()

    # -- tunel publico -----------------------------------------------------
    def start_tunnel(self) -> dict[str, Any]:
        if not Tunnel.available():
            self._tunnel.error = (
                "cloudflared nao encontrado. Instale com: "
                "winget install --id Cloudflare.cloudflared"
            )
            return self.state()
        self._tunnel.error = None
        self._server.call_soon(self._run_tunnel())
        return self.state()

    async def _run_tunnel(self) -> None:
        try:
            await self._tunnel.start()
        except Exception as exc:
            self._tunnel.error = str(exc)
        self._push("sabor:tunnel")

    # -- diagnostico de DNS ------------------------------------------------
    def dns_check(self) -> dict[str, Any]:
        """Roda o comparativo DNS do sistema x DoH e devolve para o painel.

        Sincrono de proposito: o pywebview chama isto da thread da janela e o
        painel espera a resposta.
        """
        import asyncio

        host = None
        if self._tunnel.url:
            host = self._tunnel.url.split("//", 1)[-1].split("/", 1)[0]
        try:
            return asyncio.run(dns_report(host))
        except Exception as exc:
            return {"verdict": "error", "detail": str(exc), "servers": [],
                    "routerAsResolver": False, "hijacks": [], "checks": {}}

    # -- teste do TURN -----------------------------------------------------
    def turn_check(self) -> dict[str, Any]:
        """Pede uma credencial de verdade e diz se deu certo.

        Roda no loop do servidor porque e la que a sessao HTTP vive; o painel
        espera o resultado.
        """
        import asyncio
        import concurrent.futures

        loop = self._server.loop
        if not (loop and loop.is_running()):
            return {"ok": False, "detail": "Servidor ainda subindo, tente de novo."}
        fut = asyncio.run_coroutine_threadsafe(self._server.ice.check(), loop)
        try:
            return fut.result(timeout=20)
        except concurrent.futures.TimeoutError:
            return {"ok": False, "detail": "A Cloudflare nao respondeu em 20s."}
        except Exception as exc:
            return {"ok": False, "detail": str(exc)}

    def stop_tunnel(self) -> dict[str, Any]:
        self._tunnel.stop()
        return self.state()

    # -- janela ------------------------------------------------------------
    def open_in_browser(self) -> bool:
        """Abre o painel do host no navegador padrao (plano B da captura)."""
        url = (
            f"http://127.0.0.1:{self._server.http_port}"
            f"/host?k={self._server.host_token}"
        )
        webbrowser.open(url)
        return True

    def minimize(self) -> None:
        if self._window:
            self._window.minimize()

    def toggle_maximize(self) -> None:
        win = self._window
        if not win:
            return
        try:
            if getattr(win, "_sabor_max", False):
                win.restore()
                win._sabor_max = False
            else:
                win.maximize()
                win._sabor_max = True
        except Exception:
            win.toggle_fullscreen()

    def close(self) -> None:
        self._tunnel.stop()
        if self._window:
            self._window.destroy()

    # -- interno -----------------------------------------------------------
    def _push(self, event: str) -> None:
        """Avisa a pagina que algo mudou fora dela."""
        if self._window:
            try:
                self._window.evaluate_js(
                    f"window.dispatchEvent(new CustomEvent({event!r}))"
                )
            except Exception:
                pass

    def notify_room(self) -> None:
        self._push("sabor:room")

    def shutdown(self) -> None:
        self._tunnel.stop()
