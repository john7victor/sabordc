"""Credenciais de TURN.

Duas origens possiveis:

* **manual** — voce digita URLs e senha (ou o segredo compartilhado do coturn)
  em Ajustes. Tudo resolvido localmente, sem rede.
* **cloudflare** — o app pede a cada convidado um par usuario/senha temporario
  a Cloudflare Realtime. O token da sua conta fica so aqui no PC; o que viaja
  no link e a credencial derivada, que expira sozinha.

O TURN e obrigatorio quando os dois lados estao atras de NAT que troca a porta
por destino (o caso classico de CGNAT). Sem ele nao existe rota: a midia nao
tem por onde passar.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

from .config import Settings

CF_ENDPOINT = "https://rtc.live.cloudflare.com/v1/turn/keys/{key}/credentials/generate-ice-servers"

# Margem antes do vencimento: uma credencial que expira em 30s nao serve para
# quem esta entrando agora.
RENEW_MARGIN = 120.0


def _urls(server: dict[str, Any]) -> list[str]:
    """`urls` pode vir string ou lista — a especificacao do WebRTC aceita as duas."""
    value = server.get("urls")
    if isinstance(value, str):
        return [value]
    return list(value or [])


def turn_urls(servers: list[dict[str, Any]]) -> list[str]:
    return [u for sv in servers for u in _urls(sv) if u.startswith("turn")]


class IceProvider:
    """Monta a lista de `iceServers` que vai para cada participante."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.error: Optional[str] = None
        self._last: Optional[list[dict[str, Any]]] = None
        self._last_until: float = 0.0
        self._lock = asyncio.Lock()

    async def for_peer(self, label: str = "sabor") -> list[dict[str, Any]]:
        s = self.settings
        if s.turn_provider != "cloudflare":
            self.error = None
            return s.ice_servers(label)

        if not (s.cf_turn_key_id and s.cf_turn_token):
            self.error = "Chave da Cloudflare incompleta (falta o ID ou o token)."
            return s.ice_servers(label)

        try:
            servers = await self._cloudflare()
            self.error = None
            # Mantem os STUN configurados junto: se a Cloudflare estiver fora do
            # ar, a descoberta de endereco continua funcionando por outro
            # caminho — e o diagnostico precisa de dois provedores distintos
            # para medir o NAT.
            return [{"urls": list(s.stun_urls)}] + servers if s.stun_urls else servers
        except Exception as exc:
            self.error = str(exc)
            # Uma credencial vencida ainda e melhor que nenhuma: quem ja estava
            # com alocacao aberta continua, e o STUN local segue valendo.
            if self._last:
                return self._last
            return s.ice_servers(label)

    async def _cloudflare(self) -> list[dict[str, Any]]:
        import aiohttp

        s = self.settings
        ttl = max(600, s.turn_ttl)
        async with self._lock:
            url = CF_ENDPOINT.format(key=s.cf_turn_key_id)
            async with aiohttp.ClientSession() as sess:
                async with sess.post(
                    url,
                    json={"ttl": ttl},
                    headers={"Authorization": f"Bearer {s.cf_turn_token}"},
                    timeout=aiohttp.ClientTimeout(total=12),
                ) as resp:
                    body = await resp.text()
                    if resp.status not in (200, 201):
                        raise RuntimeError(
                            f"Cloudflare respondeu {resp.status}. "
                            + ("Confira o ID da chave e o token."
                               if resp.status in (401, 403, 404)
                               else body[:200])
                        )
                    import json as _json
                    data = _json.loads(body)

            servers = data.get("iceServers")
            # A API devolve uma lista; versoes antigas devolviam um objeto so.
            if isinstance(servers, dict):
                servers = [servers]
            if not servers:
                raise RuntimeError("Cloudflare nao devolveu nenhum servidor.")

            if not turn_urls(servers):
                raise RuntimeError("A resposta da Cloudflare nao trouxe nenhum TURN.")

            self._last = servers
            self._last_until = time.time() + ttl - RENEW_MARGIN
            return servers

    def has_turn(self) -> bool:
        s = self.settings
        if s.turn_provider == "cloudflare":
            return bool(s.cf_turn_key_id and s.cf_turn_token)
        return bool(s.turn_endpoints())

    async def check(self) -> dict[str, Any]:
        """Testa a configuracao e devolve algo legivel para o painel."""
        s = self.settings
        if not self.has_turn():
            return {"ok": False, "detail": "Nenhum TURN configurado."}
        servers = await self.for_peer("teste")
        urls = turn_urls(servers)
        if self.error:
            return {"ok": False, "detail": self.error, "urls": urls}
        if not urls:
            return {"ok": False, "detail": "A configuracao nao produziu nenhuma URL de TURN."}
        return {
            "ok": True,
            "detail": f"{len(urls)} endereco(s) de TURN obtido(s).",
            "urls": urls,
            "provider": s.turn_provider,
        }
