"""Sinalizacao WebRTC: o servidor so troca ofertas/ICE, a midia nunca passa por aqui.

Topologia em estrela: o host e o unico par que fala com todo mundo. Cada
convidado manda a propria voz — e, se quiser, a propria tela — so pra ele; e o
host quem retransmite pros demais, exatamente como ja fazia com o audio. E o
que permite mais de uma transmissao ao vivo na mesma sala, sem ninguem trocar
de link.
"""

from __future__ import annotations

import asyncio
import random
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from aiohttp import WSMsgType, web

MAX_CHAT = 500
MAX_NAME = 24
MAX_SALAS = 12

# Salas que ja existem quando o app abre. A primeira e onde todo mundo cai.
# As duas de time existem pra o sorteio ter pra onde mandar as pessoas sem
# ninguem precisar criar nada antes de jogar.
SALAS_PADRAO = [
    {"id": "geral", "name": "Geral"},
    {"id": "time-a", "name": "Time A"},
    {"id": "time-b", "name": "Time B"},
]


@dataclass
class Peer:
    id: str
    name: str
    role: str  # "host" | "guest"
    ws: web.WebSocketResponse
    joined_at: float = field(default_factory=time.time)
    muted: bool = True
    sala: str = SALAS_PADRAO[0]["id"]

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "muted": self.muted,
            "sala": self.sala,
            "joinedAt": int(self.joined_at * 1000),
        }


class Room:
    """Uma sala. A instancia vive enquanto o app estiver aberto."""

    def __init__(self, on_change: Optional[Callable[[], None]] = None) -> None:
        self.peers: dict[str, Peer] = {}
        self.chat: list[dict[str, Any]] = []
        self.locked = False
        # peer.id -> quando comecou a transmitir. Qualquer um pode estar aqui,
        # nao so o host: e o que permite mais de uma transmissao na mesma sala.
        self.live: dict[str, float] = {}
        self.salas: list[dict[str, str]] = [dict(s) for s in SALAS_PADRAO]
        self.on_change = on_change
        self._lock = asyncio.Lock()

    def sala_existe(self, sala_id: str) -> bool:
        return any(s["id"] == sala_id for s in self.salas)

    # -- consultas ---------------------------------------------------------
    @property
    def host(self) -> Optional[Peer]:
        return next((p for p in self.peers.values() if p.role == "host"), None)

    @property
    def guests(self) -> list[Peer]:
        return [p for p in self.peers.values() if p.role == "guest"]

    def snapshot(self) -> dict[str, Any]:
        return {
            "peers": [p.public() for p in self.peers.values()],
            "salas": [dict(s) for s in self.salas],
            "locked": self.locked,
            # Lista, nao mais um booleano: varias pessoas podem estar
            # transmitindo ao mesmo tempo na mesma sala.
            "live": [
                {"id": pid, "startedAt": int(ts * 1000)}
                for pid, ts in self.live.items()
            ],
        }

    # -- envio -------------------------------------------------------------
    async def send(self, peer: Peer, msg: dict[str, Any]) -> None:
        try:
            await peer.ws.send_json(msg)
        except (ConnectionResetError, RuntimeError):
            pass

    async def broadcast(self, msg: dict[str, Any], skip: str | None = None) -> None:
        await asyncio.gather(
            *(self.send(p, msg) for p in list(self.peers.values()) if p.id != skip),
            return_exceptions=True,
        )

    def _changed(self) -> None:
        if self.on_change:
            try:
                self.on_change()
            except Exception:
                pass

    # -- ciclo de vida do par ---------------------------------------------
    async def join(self, name: str, role: str, ws: web.WebSocketResponse) -> Peer:
        async with self._lock:
            if role == "host":
                old = self.host
                if old:  # so um host; a janela nova assume a sala
                    await self.send(old, {"t": "replaced"})
                    await old.ws.close()
                    self.peers.pop(old.id, None)
            peer = Peer(
                id=secrets.token_hex(6),
                name=name[:MAX_NAME] or "Convidado",
                role=role,
                ws=ws,
            )
            self.peers[peer.id] = peer

        await self.send(peer, {
            "t": "welcome",
            "you": peer.public(),
            "room": self.snapshot(),
            "chat": self.chat[-50:],
        })
        await self.broadcast({"t": "peer-join", "peer": peer.public()}, skip=peer.id)
        self._changed()
        return peer

    async def leave(self, peer: Peer) -> None:
        async with self._lock:
            self.peers.pop(peer.id, None)
            was_live = self.live.pop(peer.id, None) is not None
        # Antes do peer-leave: quem estava vendo a transmissao dele tira o
        # quadro da grade antes de tirar a pessoa da lista.
        if was_live:
            await self.broadcast({"t": "live", "id": peer.id, "on": False})
        await self.broadcast({"t": "peer-leave", "id": peer.id})
        self._changed()

    # -- mensagens ---------------------------------------------------------
    async def handle(self, peer: Peer, msg: dict[str, Any]) -> None:
        kind = msg.get("t")

        if kind == "signal":
            target = self.peers.get(msg.get("to", ""))
            if target:
                await self.send(target, {
                    "t": "signal",
                    "from": peer.id,
                    "payload": msg.get("payload"),
                })

        elif kind == "state":
            peer.muted = bool(msg.get("muted", peer.muted))
            await self.broadcast({"t": "state", "id": peer.id, "muted": peer.muted})
            self._changed()

        elif kind == "rename":
            peer.name = str(msg.get("name", peer.name))[:MAX_NAME] or peer.name
            await self.broadcast({"t": "peer-update", "peer": peer.public()})
            self._changed()

        elif kind == "chat":
            text = str(msg.get("text", "")).strip()[:MAX_CHAT]
            if not text:
                return
            entry = {
                "id": secrets.token_hex(4),
                "from": peer.id,
                "name": peer.name,
                "text": text,
                "ts": int(time.time() * 1000),
            }
            self.chat.append(entry)
            del self.chat[:-200]
            await self.broadcast({"t": "chat", **entry})

        elif kind == "live":
            # Qualquer um pode transmitir, host ou convidado: e o que permite
            # duas pessoas ao vivo ao mesmo tempo, na mesma sala, sem trocar
            # de link.
            on = bool(msg.get("on"))
            if on:
                self.live[peer.id] = time.time()
            else:
                self.live.pop(peer.id, None)
            await self.broadcast({
                "t": "live",
                "id": peer.id,
                "on": on,
                "startedAt": int(self.live[peer.id] * 1000) if on else None,
            })
            self._changed()

        elif kind == "sala":
            # Qualquer um pode trocar de sala sozinho, como num canal de voz.
            await self._mover(peer.id, str(msg.get("id", "")))

        elif kind == "admin":
            if peer.role == "host":
                await self._admin(msg)

        elif kind == "ping":
            await self.send(peer, {"t": "pong", "ts": msg.get("ts")})

    # -- salas -------------------------------------------------------------
    async def _mover(self, peer_id: str, sala_id: str) -> None:
        peer = self.peers.get(peer_id)
        if not peer or not self.sala_existe(sala_id) or peer.sala == sala_id:
            return
        peer.sala = sala_id
        # Todo mundo precisa saber: quem esta numa sala so ouve quem esta na
        # mesma, e e o painel do host que refaz os encaminhamentos de audio.
        await self.broadcast({"t": "sala-troca", "id": peer.id, "sala": sala_id})
        self._changed()

    async def _admin(self, msg: dict[str, Any]) -> None:
        action = msg.get("action")

        if action == "kick":
            target = self.peers.get(msg.get("id", ""))
            if target and target.role == "guest":
                await self.send(target, {"t": "kicked", "reason": msg.get("reason", "")})
                await target.ws.close()

        elif action == "lock":
            self.locked = bool(msg.get("value"))
            await self.broadcast({"t": "room", "room": self.snapshot()})
            self._changed()

        elif action == "mute":
            target = self.peers.get(msg.get("id", ""))
            if target:
                await self.send(target, {"t": "force-mute"})

        elif action == "mute-all":
            for g in self.guests:
                await self.send(g, {"t": "force-mute"})

        elif action == "sala-criar":
            nome = str(msg.get("name", "")).strip()[:MAX_NAME] or "Sala"
            if len(self.salas) < MAX_SALAS:
                self.salas.append({"id": secrets.token_hex(3), "name": nome})
                await self.broadcast({"t": "salas", "salas": self.salas})
                self._changed()

        elif action == "sala-renomear":
            sala = next((s for s in self.salas if s["id"] == msg.get("id")), None)
            nome = str(msg.get("name", "")).strip()[:MAX_NAME]
            if sala and nome:
                sala["name"] = nome
                await self.broadcast({"t": "salas", "salas": self.salas})
                self._changed()

        elif action == "sala-apagar":
            sala_id = str(msg.get("id", ""))
            # A primeira sala nunca some: e o destino de quem fica sem sala.
            if sala_id and self.salas and sala_id != self.salas[0]["id"]:
                self.salas = [s for s in self.salas if s["id"] != sala_id]
                for p in list(self.peers.values()):
                    if p.sala == sala_id:
                        await self._mover(p.id, self.salas[0]["id"])
                await self.broadcast({"t": "salas", "salas": self.salas})
                self._changed()

        elif action == "mover":
            await self._mover(str(msg.get("id", "")), str(msg.get("sala", "")))

        elif action == "sortear":
            await self._sortear(str(msg.get("a", "")), str(msg.get("b", "")))

        elif action == "reunir":
            destino = str(msg.get("id", "")) or (self.salas[0]["id"] if self.salas else "")
            if self.sala_existe(destino):
                for p in list(self.peers.values()):
                    await self._mover(p.id, destino)

    async def _sortear(self, sala_a: str, sala_b: str) -> None:
        """Embaralha quem esta conectado e joga metade em cada sala.

        Inclui o host: ele joga junto, entao deixar ele de fora daria times
        de tamanho diferente. Quem esta transmitindo tambem entra no sorteio —
        a transmissao acompanha a pessoa pra sala nova.
        """
        if not (self.sala_existe(sala_a) and self.sala_existe(sala_b)):
            return
        pessoas = list(self.peers.values())
        if len(pessoas) < 2:
            return
        random.shuffle(pessoas)
        meio = len(pessoas) // 2  # com numero impar, a sala A fica com um a menos
        for i, p in enumerate(pessoas):
            await self._mover(p.id, sala_a if i < meio else sala_b)
        await self.broadcast({"t": "sorteio", "a": sala_a, "b": sala_b})


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    """Endpoint /ws. Autentica pela query string e entrega o par a sala."""
    app = request.app
    room: Room = app["room"]
    settings = app["settings"]

    token = request.query.get("token", "")
    if token and secrets.compare_digest(token, app["host_token"]):
        role = "host"
    elif token and secrets.compare_digest(token, settings.join_token):
        role = "guest"
    else:
        return web.Response(status=403, text="token invalido")

    if role == "guest":
        if room.locked:
            return web.Response(status=423, text="sala trancada")
        if len(room.guests) >= settings.max_guests:
            return web.Response(status=409, text="sala cheia")

    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=1 << 20)
    await ws.prepare(request)

    peer = await room.join(request.query.get("name", "Convidado"), role, ws)
    try:
        async for raw in ws:
            if raw.type is not WSMsgType.TEXT:
                continue
            try:
                data = raw.json()
            except ValueError:
                continue
            if isinstance(data, dict):
                await room.handle(peer, data)
    finally:
        await room.leave(peer)
    return ws
