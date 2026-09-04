"""Configuracao persistida e caminhos da aplicacao."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

FROZEN = getattr(sys, "frozen", False)


def _app_dir() -> Path:
    """Onde ficam os recursos (a pasta web/).

    Empacotado pelo PyInstaller eles vao para o bundle (_MEIPASS); rodando do
    codigo-fonte, para a raiz do projeto.
    """
    if FROZEN:
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def _exe_dir() -> Path:
    """Onde o app foi instalado — e onde procuramos binarios opcionais como o
    cloudflared. Nao e a mesma coisa que _app_dir() num build onefile."""
    return Path(sys.executable).parent if FROZEN else _app_dir()


APP_DIR = _app_dir()
EXE_DIR = _exe_dir()
WEB_DIR = APP_DIR / "web"

# Dois provedores diferentes de proposito. Os dois enderecos do Google podem
# cair no mesmo anycast: para o diagnostico saber se o NAT e simetrico e preciso
# que dois servidores realmente distintos vejam a mesma porta.
DEFAULT_STUN = [
    "stun:stun.l.google.com:19302",
    "stun:stun.cloudflare.com:3478",
]

OLD_DEFAULT_STUN = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]


def _data_dir() -> Path:
    base = os.environ.get("APPDATA") or os.environ.get("XDG_CONFIG_HOME")
    root = Path(base) if base else Path.home() / ".config"
    d = root / "SABOR"
    d.mkdir(parents=True, exist_ok=True)
    return d


DATA_DIR = _data_dir()
CONFIG_FILE = DATA_DIR / "config.json"
CERT_FILE = DATA_DIR / "sabor-cert.pem"
KEY_FILE = DATA_DIR / "sabor-key.pem"


@dataclass
class Settings:
    display_name: str = "Host"
    room_name: str = "Sala do Sabor DC"
    http_port: int = 8770
    https_port: int = 8771

    # qualidade da transmissao
    resolution: str = "1080p"      # 720p | 1080p | 1440p | nativa
    framerate: int = 60            # 30 | 60
    bitrate_kbps: int = 6000       # teto por espectador

    # sala
    max_guests: int = 8
    guests_can_talk: bool = True

    # rede
    # Ligado por padrao: sem tunel o link so vale na rede local, e o caso de uso
    # normal e ter os amigos em outra cidade.
    auto_tunnel: bool = True
    stun_urls: list[str] = field(default_factory=lambda: list(DEFAULT_STUN))

    # TURN. `turn_urls` aceita varias entradas porque uma so nunca cobre tudo:
    # o `turn:` em UDP e o caminho bom, e o `turns:...:443?transport=tcp` e o
    # unico que passa em rede corporativa que bloqueia UDP.
    # "manual" (URLs e senha digitadas) ou "cloudflare" (credencial temporaria
    # pedida a Cloudflare Realtime a cada convidado que entra).
    turn_provider: str = "manual"
    cf_turn_key_id: str = ""
    cf_turn_token: str = ""

    turn_urls: list[str] = field(default_factory=list)
    turn_user: str = ""
    turn_pass: str = ""
    # Segredo compartilhado do coturn (`use-auth-secret`). Preenchido isto, cada
    # convidado recebe usuario e senha que expiram — sem ele, a senha fixa do
    # seu relay vai junto com o link para qualquer um que entrar na sala.
    turn_secret: str = ""
    turn_ttl: int = 3600
    # Pula a tentativa de conexao direta e ja vai pelo TURN. Sob CGNAT
    # simetrico a tentativa direta so atrasa a entrada em ~10s e falha.
    force_relay: bool = False

    turn_url: str = ""  # compatibilidade: versoes antigas guardavam uma so

    room_id: str = field(default_factory=lambda: secrets.token_hex(4))
    join_token: str = field(default_factory=lambda: secrets.token_urlsafe(9))

    # -- persistencia ------------------------------------------------------
    @classmethod
    def load(cls) -> "Settings":
        if CONFIG_FILE.exists():
            try:
                raw = json.loads(CONFIG_FILE.read_text("utf-8"))
                known = set(cls.__dataclass_fields__)
                s = cls(**{k: v for k, v in raw.items() if k in known})
                if s.turn_url and not s.turn_urls:  # config de versao anterior
                    s.turn_urls = [s.turn_url]
                if s.stun_urls == OLD_DEFAULT_STUN:  # idem: dois enderecos do
                    s.stun_urls = list(DEFAULT_STUN)  # mesmo provedor
                return s
            except Exception:
                pass  # config corrompida: recomeca do zero
        s = cls()
        s.save()
        return s

    def save(self) -> None:
        CONFIG_FILE.write_text(
            json.dumps(asdict(self), indent=2, ensure_ascii=False), "utf-8"
        )

    def update(self, patch: dict[str, Any]) -> "Settings":
        for key, value in patch.items():
            if key in self.__dataclass_fields__ and key not in {"room_id", "join_token"}:
                setattr(self, key, value)
        self.save()
        return self

    def rotate_link(self) -> None:
        """Invalida o link antigo: quem tiver o endereco velho para de entrar."""
        self.room_id = secrets.token_hex(4)
        self.join_token = secrets.token_urlsafe(9)
        self.save()

    # -- webrtc ------------------------------------------------------------
    def turn_endpoints(self) -> list[str]:
        urls = [u.strip() for u in self.turn_urls if u.strip()]
        if not urls and self.turn_url.strip():
            urls = [self.turn_url.strip()]
        return urls

    def turn_credentials(self, label: str = "sabor") -> tuple[str, str]:
        """Usuario e senha para o TURN.

        Com `turn_secret` preenchido gera o par temporario do coturn
        (`use-auth-secret`): usuario e `expiracao:rotulo` e a senha e o HMAC
        disso. Assim o que viaja no link vale por uma hora, nao para sempre.
        """
        if not self.turn_secret:
            return self.turn_user, self.turn_pass
        expiry = int(time.time()) + max(60, self.turn_ttl)
        username = f"{expiry}:{label}"
        digest = hmac.new(self.turn_secret.encode(), username.encode(),
                          hashlib.sha1).digest()
        return username, base64.b64encode(digest).decode()

    def ice_servers(self, label: str = "sabor") -> list[dict[str, Any]]:
        servers: list[dict[str, Any]] = [{"urls": self.stun_urls}]
        urls = self.turn_endpoints()
        if urls:
            user, password = self.turn_credentials(label)
            servers.append({
                "urls": urls,
                "username": user,
                "credential": password,
            })
        return servers
