"""Servidor local: serve o painel do host, a pagina dos convidados e a sinalizacao.

Roda no PC de quem inicia a transmissao. A midia (tela + voz) nunca passa por
aqui: vai direto de par a par por WebRTC. Este processo so carrega texto.
"""

from __future__ import annotations

import asyncio
import secrets
from typing import Any, Callable, Optional

from aiohttp import web

from . import APP_NAME, __version__
from .config import WEB_DIR, Settings
from .net import lan_ip, ssl_context
from .signaling import Room, ws_handler
from .turn import IceProvider

LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _is_local(request: web.Request) -> bool:
    peer = request.transport.get_extra_info("peername") if request.transport else None
    return bool(peer) and peer[0] in LOOPBACK


@web.middleware
async def security_headers(request: web.Request, handler):
    resp = await handler(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Permissions-Policy", "microphone=(self), display-capture=(self)")
    if request.path.startswith("/static/"):
        # Revalida sempre: sem isso o WebView2 continua servindo o CSS antigo
        # depois de uma atualização do app.
        resp.headers["Cache-Control"] = "no-cache"
    elif request.path.endswith((".html", "/")) or request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


class Server:
    """Ciclo de vida do aiohttp em uma thread de asyncio propria."""

    def __init__(self, settings: Settings, on_change: Callable[[], None] | None = None):
        self.settings = settings
        self.host_token = secrets.token_urlsafe(24)
        self.room = Room(on_change=on_change)
        self.ice = IceProvider(settings)
        self.lan = lan_ip()
        self.http_port = settings.http_port
        self.https_port: Optional[int] = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._runner: Optional[web.AppRunner] = None
        self.app = self._build()

    # -- construcao --------------------------------------------------------
    def _build(self) -> web.Application:
        app = web.Application(middlewares=[security_headers])
        app["settings"] = self.settings
        app["room"] = self.room
        app["host_token"] = self.host_token

        app.router.add_get("/", self.page_root)
        app.router.add_get("/host", self.page_host)
        app.router.add_get("/j/{room}", self.page_join)
        app.router.add_get("/api/bootstrap", self.api_bootstrap)
        app.router.add_get("/api/ice", self.api_ice)
        app.router.add_get("/api/health", self.api_health)
        app.router.add_get("/ws", ws_handler)
        app.router.add_static("/static", WEB_DIR, follow_symlinks=False)
        return app

    # -- paginas -----------------------------------------------------------
    async def page_root(self, request: web.Request) -> web.StreamResponse:
        if _is_local(request):
            raise web.HTTPFound(f"/host?k={self.host_token}")
        return self._page("landing.html")

    async def page_host(self, request: web.Request) -> web.StreamResponse:
        token = request.query.get("k", "")
        if not (_is_local(request) and secrets.compare_digest(token, self.host_token)):
            raise web.HTTPForbidden(text="O painel do host so abre nesta maquina.")
        return self._page("host.html")

    async def page_join(self, request: web.Request) -> web.StreamResponse:
        if request.match_info["room"] != self.settings.room_id:
            return self._page("landing.html", status=404)
        return self._page("join.html")

    def _page(self, name: str, status: int = 200) -> web.Response:
        body = (WEB_DIR / name).read_text("utf-8")
        return web.Response(text=body, content_type="text/html", status=status,
                            charset="utf-8")

    # -- api ---------------------------------------------------------------
    async def api_bootstrap(self, request: web.Request) -> web.Response:
        """Dados que a pagina precisa antes de abrir o WebSocket."""
        s = self.settings
        token = request.query.get("t", "")
        is_host = _is_local(request) and secrets.compare_digest(
            request.query.get("k", ""), self.host_token
        )
        if not is_host and not (token and secrets.compare_digest(token, s.join_token)):
            raise web.HTTPForbidden(text="link invalido ou expirado")

        data: dict[str, Any] = {
            "app": APP_NAME,
            "version": __version__,
            "roomId": s.room_id,
            "roomName": s.room_name,
            "role": "host" if is_host else "guest",
            "token": self.host_token if is_host else s.join_token,
            "room": self.room.snapshot(),
            "guestsCanTalk": s.guests_can_talk,
            "maxGuests": s.max_guests,
            # Rotulo por pessoa: com TURN de credencial temporaria, cada um
            # recebe um par proprio e a revogacao de um nao derruba os outros.
            "ice": await self.ice.for_peer("host" if is_host else secrets.token_hex(4)),
            "forceRelay": s.force_relay,
            "hasTurn": self.ice.has_turn(),
        }
        if is_host:
            data["quality"] = {
                "resolution": s.resolution,
                "framerate": s.framerate,
                "bitrateKbps": s.bitrate_kbps,
            }
            data["hostName"] = s.display_name
            data["links"] = self.links()
        return web.json_response(data)

    async def api_ice(self, request: web.Request) -> web.Response:
        s = self.settings
        token = request.query.get("t", "")
        is_host = _is_local(request) and secrets.compare_digest(
            request.query.get("k", ""), self.host_token
        )
        if not is_host and not (token and secrets.compare_digest(token, s.join_token)):
            raise web.HTTPForbidden(text="link invalido ou expirado")
        return web.json_response({
            "iceServers": await self.ice.for_peer("host" if is_host else secrets.token_hex(4)),
            "forceRelay": s.force_relay,
        })

    async def api_health(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "version": __version__,
                                  "peers": len(self.room.peers)})

    # -- links -------------------------------------------------------------
    def links(self, public_url: str | None = None) -> dict[str, Optional[str]]:
        s = self.settings
        path = f"/j/{s.room_id}?t={s.join_token}"
        lan = None
        if self.https_port:
            lan = f"https://{self.lan}:{self.https_port}{path}"
        elif self.lan != "127.0.0.1":
            lan = f"http://{self.lan}:{self.http_port}{path}"
        return {
            "public": f"{public_url.rstrip('/')}{path}" if public_url else None,
            "lan": lan,
            "local": f"http://127.0.0.1:{self.http_port}{path}",
        }

    # -- execucao ----------------------------------------------------------
    async def _serve(self) -> None:
        self.loop = asyncio.get_running_loop()
        self._runner = web.AppRunner(self.app, access_log=None)
        await self._runner.setup()

        await web.TCPSite(self._runner, "0.0.0.0", self.http_port).start()

        ctx = ssl_context(self.lan)
        if ctx:
            try:
                await web.TCPSite(self._runner, "0.0.0.0", self.settings.https_port,
                                  ssl_context=ctx).start()
                self.https_port = self.settings.https_port
            except OSError:
                self.https_port = None

        await asyncio.Event().wait()  # mantem o loop vivo ate o processo sair

    def run_forever(self) -> None:
        """Chamado em uma thread daemon a partir do processo principal."""
        try:
            asyncio.run(self._serve())
        except (KeyboardInterrupt, SystemExit):
            pass

    def call_soon(self, coro) -> None:
        """Agenda uma corrotina no loop do servidor a partir de outra thread."""
        if self.loop and self.loop.is_running():
            asyncio.run_coroutine_threadsafe(coro, self.loop)
