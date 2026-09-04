"""Baixa a versao nova em segundo plano, pronta pra instalar num clique.

Por que so baixa e nao instala sozinho: o instalador precisa de elevacao
(e ele quem cria a regra do Firewall), entao o Windows sempre vai mostrar o
prompt do UAC — nao existe instalacao 100% silenciosa aqui. O que da pra
tirar do caminho e a espera do download, que e a parte demorada.

O arquivo baixado fica no cache do app, nao no Downloads da pessoa: e um
detalhe interno da atualizacao, e some quando uma versao mais nova chega.
"""

from __future__ import annotations

import os
import subprocess
import threading
import urllib.request
from pathlib import Path
from typing import Any, Optional

from .config import DATA_DIR

# So aceitamos baixar (e depois executar) de um lugar: os anexos de release
# deste repositorio. Estes metodos ficam expostos ao JavaScript da pagina —
# sem essa trava, um painel comprometido teria como fazer o app baixar e
# rodar qualquer executavel da internet.
ALLOWED_PREFIX = "https://github.com/john7victor/sabordc/releases/download/"

CACHE_DIR = DATA_DIR / "update"


class Updater:
    """Estado do download. Uma instancia por processo, consultada pelo painel."""

    def __init__(self) -> None:
        self.state = "idle"       # idle | downloading | ready | error
        self.percent = 0
        self.detail = ""
        self.path: Optional[Path] = None
        self._thread: Optional[threading.Thread] = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "percent": self.percent,
            "detail": self.detail,
            "file": self.path.name if self.path else None,
        }

    # -- download ----------------------------------------------------------
    def start(self, url: str) -> dict[str, Any]:
        if not url.startswith(ALLOWED_PREFIX):
            self.state, self.detail = "error", "endereco de download nao permitido"
            return self.snapshot()
        if self.state in ("downloading", "ready"):
            return self.snapshot()

        self.state, self.percent, self.detail = "downloading", 0, ""
        self._thread = threading.Thread(
            target=self._download, args=(url,), name="sabor-update", daemon=True
        )
        self._thread.start()
        return self.snapshot()

    def _download(self, url: str) -> None:
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            # Limpa downloads de versoes anteriores: so faz sentido guardar a
            # que esta sendo oferecida agora.
            for old in CACHE_DIR.iterdir():
                try:
                    old.unlink()
                except OSError:
                    pass

            name = url.rsplit("/", 1)[-1] or "sabor-update.exe"
            destino = CACHE_DIR / name
            parcial = destino.with_suffix(destino.suffix + ".part")

            req = urllib.request.Request(url, headers={"User-Agent": "SaborDC"})
            with urllib.request.urlopen(req, timeout=30) as resp, open(parcial, "wb") as out:
                total = int(resp.headers.get("Content-Length") or 0)
                baixado = 0
                while True:
                    bloco = resp.read(256 * 1024)
                    if not bloco:
                        break
                    out.write(bloco)
                    baixado += len(bloco)
                    if total:
                        self.percent = min(99, round(baixado * 100 / total))

            parcial.replace(destino)
            self.path = destino
            self.percent = 100
            self.state = "ready"
        except Exception as exc:
            self.state, self.detail = "error", str(exc)

    # -- instalacao --------------------------------------------------------
    def run(self) -> bool:
        """Abre o instalador baixado. O UAC aparece aqui — e o Windows
        pedindo elevacao, nao tem como pular."""
        if self.state != "ready" or not self.path or not self.path.exists():
            return False
        try:
            # Sem shell=True: o caminho vem do nosso proprio cache, mas manter
            # a chamada literal evita qualquer interpretacao do shell.
            subprocess.Popen([str(self.path)], close_fds=True)
            return True
        except OSError:
            return False


def clear_cache() -> None:
    """Apaga o instalador guardado — chamado quando o app ja esta atualizado."""
    if not CACHE_DIR.exists():
        return
    for item in CACHE_DIR.iterdir():
        try:
            item.unlink()
        except OSError:
            pass
    try:
        os.rmdir(CACHE_DIR)
    except OSError:
        pass
