"""Rede: IP da LAN, portas livres, certificado local e túnel público."""

from __future__ import annotations

import asyncio
import datetime as dt
import ipaddress
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
from pathlib import Path
from typing import Callable, Optional

from aiohttp.abc import AbstractResolver, ResolveResult

from .config import CERT_FILE, EXE_DIR, KEY_FILE


def lan_ip() -> str:
    """IP da maquina na rede local (sem depender de resolucao de nome).

    O destino e um endereco publico de proposito. O truque antigo apontava para
    `10.255.255.255`, e numa maquina com VPN esse endereco casa com a rota da
    propria VPN — o app anunciava o IP do tunel (que ninguem da casa alcanca)
    como se fosse o da rede local. Mirando um IP publico o sistema escolhe a
    interface da rota padrao, que e por onde os outros realmente chegam.

    Nada e enviado: `connect` em UDP so seleciona a rota.
    """
    for target in ("1.1.1.1", "8.8.8.8"):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((target, 53))
            ip = s.getsockname()[0]
            if not ip.startswith("169.254."):  # link-local: interface sem rede
                return ip
        except Exception:
            continue
        finally:
            s.close()
    return "127.0.0.1"


def free_port(preferred: int, tries: int = 40) -> int:
    """Devolve `preferred` se estiver livre, senão a próxima porta livre."""
    for port in range(preferred, preferred + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("0.0.0.0", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"Nenhuma porta livre entre {preferred} e {preferred + tries}")


# --------------------------------------------------------------------------- #
# TLS local
# --------------------------------------------------------------------------- #

def ensure_cert(host_ip: str) -> tuple[str, str]:
    """Gera (ou reaproveita) um certificado autoassinado cobrindo o IP da LAN.

    Necessário porque `getUserMedia` (microfone) só roda em contexto seguro:
    https ou localhost. Sem isso, quem entra pela LAN entra sem microfone.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    if CERT_FILE.exists() and KEY_FILE.exists():
        try:
            cert = x509.load_pem_x509_certificate(CERT_FILE.read_bytes())
            san = cert.extensions.get_extension_for_class(
                x509.SubjectAlternativeName
            ).value
            ips = {str(i) for i in san.get_values_for_type(x509.IPAddress)}
            fresh = cert.not_valid_after_utc > dt.datetime.now(dt.timezone.utc)
            if host_ip in ips and fresh:
                return str(CERT_FILE), str(KEY_FILE)
        except Exception:
            pass  # certificado velho/corrompido: regenera

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Sabor DC Local")])
    alt = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    try:
        alt.append(x509.IPAddress(ipaddress.ip_address(host_ip)))
    except ValueError:
        pass

    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(alt), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    KEY_FILE.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    CERT_FILE.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return str(CERT_FILE), str(KEY_FILE)


def ssl_context(host_ip: str) -> Optional[ssl.SSLContext]:
    try:
        cert, key = ensure_cert(host_ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        return ctx
    except Exception as exc:  # cryptography ausente ou falha de escrita
        print(f"[sabor] TLS local indisponível: {exc}", file=sys.stderr)
        return None


# --------------------------------------------------------------------------- #
# DNS
# --------------------------------------------------------------------------- #

# Endpoints DoH escritos como IP literal de proposito: assim nada aqui depende
# do resolvedor do sistema — que e justamente a peca que queremos testar (e,
# quando ela estiver quebrada, contornar).
DOH_ENDPOINTS = ("https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query")

QUICK_TUNNEL_API = "api.trycloudflare.com"
# Nome que NUNCA existe: .invalid e reservado pela RFC 2606. Se o resolvedor
# devolver um IP para isto, ele esta sequestrando NXDOMAIN (varios provedores
# brasileiros fazem isso e mandam para uma pagina de busca).
BOGUS_NAME = "sabor-nxdomain-check.invalid"


async def resolve_doh(name: str, rtype: str = "A", timeout: float = 6.0) -> list[str]:
    """Resolve `name` falando DNS-sobre-HTTPS direto com 1.1.1.1 / 8.8.8.8."""
    import aiohttp

    headers = {"accept": "application/dns-json"}
    params = {"name": name, "type": rtype}
    async with aiohttp.ClientSession() as sess:
        for endpoint in DOH_ENDPOINTS:
            try:
                async with sess.get(
                    endpoint, params=params, headers=headers,
                    timeout=aiohttp.ClientTimeout(total=timeout),
                ) as resp:
                    if resp.status != 200:
                        continue
                    data = await resp.json(content_type=None)
            except Exception:
                continue
            ips = [a["data"] for a in (data.get("Answer") or [])
                   if a.get("type") in (1, 28) and a.get("data")]
            if ips:
                return ips
    return []


async def resolve_system(name: str, timeout: float = 6.0) -> list[str]:
    """Resolve `name` pelo resolvedor do sistema (no Windows, o DNS do adaptador
    — normalmente o roteador)."""
    loop = asyncio.get_running_loop()

    def _lookup() -> list[str]:
        infos = socket.getaddrinfo(name, None, proto=socket.IPPROTO_TCP)
        return sorted({i[4][0] for i in infos})

    try:
        return await asyncio.wait_for(loop.run_in_executor(None, _lookup), timeout)
    except Exception:
        return []


def system_dns_servers() -> list[str]:
    """Quais servidores de DNS o Windows esta usando. Best-effort: serve so
    para o diagnostico dizer 'o culpado e o 192.168.0.1'."""
    if sys.platform != "win32":
        return []
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "(Get-DnsClientServerAddress -AddressFamily IPv4 |"
             " Where-Object {$_.ServerAddresses}).ServerAddresses -join ','"],
            capture_output=True, text=True, timeout=8,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except Exception:
        return []
    seen: list[str] = []
    for line in out.stdout.splitlines():
        for item in line.split(","):
            item = item.strip()
            if item and item not in seen:
                seen.append(item)
    return seen


def _is_private(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return False


async def dns_report(extra_name: str | None = None) -> dict:
    """Compara o resolvedor do sistema com o DoH e diz quem esta errado.

    E o diagnostico do caso 'so funcionou quando fixei um DNS no PC': o
    roteador e um encaminhador de DNS, e quando ele falha (cache negativo do
    nome novo do tunel, DNSSEC do provedor, sequestro de NXDOMAIN) o cloudflared
    nao sobe e o link recem-criado nao resolve nesta maquina.
    """
    names = [QUICK_TUNNEL_API]
    if extra_name:
        names.append(extra_name)

    checks: dict[str, dict] = {}
    for name in names:
        sysr, doh = await asyncio.gather(resolve_system(name), resolve_doh(name))
        checks[name] = {"system": sysr, "doh": doh, "ok": bool(sysr)}

    hijack = await resolve_system(BOGUS_NAME)
    servers = system_dns_servers()

    broken = [n for n, c in checks.items() if not c["ok"] and c["doh"]]
    verdict = "ok"
    detail = "O DNS desta maquina esta resolvendo os nomes do tunel."
    if broken:
        verdict = "broken"
        detail = (
            f"O DNS desta maquina nao resolve {broken[0]}, mas o 1.1.1.1 resolve. "
            "O servidor de DNS configurado (normalmente o roteador) e o problema."
        )
    elif hijack:
        verdict = "hijack"
        detail = (
            "O seu DNS responde com um IP ate para dominios que nao existem "
            f"({BOGUS_NAME} -> {hijack[0]}). Isso faz o app achar que o link do "
            "tunel ja esta no ar quando ele ainda nao esta."
        )

    return {
        "verdict": verdict,
        "detail": detail,
        "servers": servers,
        "routerAsResolver": any(_is_private(s) for s in servers),
        "hijacks": hijack,
        "checks": checks,
    }


class DohResolver(AbstractResolver):
    """Resolvedor do aiohttp que ignora o DNS do sistema.

    Usado so na sondagem do tunel: o nome `*.trycloudflare.com` acabou de ser
    criado, e roteadores com dnsmasq guardam o NXDOMAIN da primeira consulta
    por minutos. Perguntando direto ao 1.1.1.1 a sondagem para de mentir.
    """

    async def resolve(self, host: str, port: int = 0,
                      family: socket.AddressFamily = socket.AF_INET) -> list[ResolveResult]:
        def _entry(ip: str, fam: socket.AddressFamily) -> ResolveResult:
            return {"hostname": host, "host": ip, "port": port,
                    "family": fam, "proto": 0, "flags": 0}

        try:
            addr = ipaddress.ip_address(host)
            fam = socket.AF_INET6 if addr.version == 6 else socket.AF_INET
            return [_entry(host, fam)]
        except ValueError:
            pass

        ips = await resolve_doh(host, "AAAA" if family == socket.AF_INET6 else "A")
        if not ips:
            raise OSError(f"DoH nao resolveu {host}")
        return [_entry(ip, socket.AF_INET6 if ":" in ip else socket.AF_INET) for ip in ips]

    async def close(self) -> None:
        return None


# --------------------------------------------------------------------------- #
# Túnel público (cloudflared)
# --------------------------------------------------------------------------- #

_URL_RE = re.compile(rb"https://[a-z0-9-]+\.trycloudflare\.com")


class Tunnel:
    """Expõe o servidor local na internet via `cloudflared` (quando instalado).

    Sem túnel o link só funciona na LAN — o servidor continua sendo esta
    máquina de qualquer forma; o túnel apenas encaminha as conexões.
    """

    def __init__(self, port: int) -> None:
        self.port = port
        self.url: Optional[str] = None
        self.error: Optional[str] = None
        # O nome novo leva alguns segundos para o DNS propagar. Ate `ready`
        # virar True o link existe mas ainda nao resolve para quem receber.
        self.ready = False
        # A sondagem nao conseguiu confirmar o endereco a tempo. Nao quer dizer
        # que o tunel esta fora do ar — so que nao da para prometer que esta.
        self.unconfirmed = False
        self.dns: Optional[dict] = None
        self.on_ready: Callable[[], None] | None = None
        self._proc: Optional[subprocess.Popen] = None
        self._probe_task: Optional[asyncio.Task] = None

    @staticmethod
    def find_exe() -> Optional[str]:
        """Procura o cloudflared alem do PATH.

        Quem instala com o app aberto nao tem o PATH atualizado no processo, e
        o instalador do winget nem sempre poe a pasta no PATH. Sem isto o app
        insistiria em dizer que o cloudflared nao existe ate reiniciar.
        """
        found = shutil.which("cloudflared")
        if found:
            return found

        candidates = [
            EXE_DIR / "cloudflared.exe",  # ao lado do app (instalado ou portatil)
            # Rodando do codigo-fonte: a copia que o build embute no instalador
            # ja esta aqui, entao dev e app usam o mesmo binario de 52 MB.
            EXE_DIR / "installer" / "cloudflared.exe",
            Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
            / "cloudflared" / "cloudflared.exe",
            Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
            / "cloudflared" / "cloudflared.exe",
        ]
        local = os.environ.get("LOCALAPPDATA")
        if local:
            candidates.append(Path(local) / "Microsoft" / "WinGet" / "Links" / "cloudflared.exe")

        for path in candidates:
            try:
                if path.is_file():
                    return str(path)
            except OSError:
                continue
        return None

    @staticmethod
    def available() -> bool:
        return Tunnel.find_exe() is not None

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    async def start(self, on_url: Callable[[str], None] | None = None) -> str:
        if self.running and self.url:
            return self.url
        exe = Tunnel.find_exe()
        if not exe:
            raise RuntimeError(
                "cloudflared não encontrado. Instale com: winget install Cloudflare.cloudflared"
            )

        # O cloudflared usa o resolvedor do sistema para achar a api e a borda
        # da Cloudflare. Se ele estiver quebrado, o processo morre com uma
        # mensagem generica 30s depois — melhor dizer logo qual e o problema.
        self.dns = await dns_report()
        if self.dns["verdict"] == "broken":
            raise RuntimeError(
                self.dns["detail"]
                + (f" DNS em uso: {', '.join(self.dns['servers'])}."
                   if self.dns["servers"] else "")
                + " Troque o DNS do adaptador para 1.1.1.1 e 8.8.8.8."
            )

        self.url = None
        self.error = None
        self.unconfirmed = False
        flags = 0
        if sys.platform == "win32":
            flags = subprocess.CREATE_NO_WINDOW
        self._proc = subprocess.Popen(
            [exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{self.port}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=flags,
        )

        loop = asyncio.get_running_loop()

        def _read() -> Optional[str]:
            assert self._proc and self._proc.stdout
            for line in self._proc.stdout:
                m = _URL_RE.search(line)
                if m:
                    return m.group(0).decode()
                if self._proc.poll() is not None:
                    break
            return None

        try:
            url = await asyncio.wait_for(loop.run_in_executor(None, _read), timeout=30)
        except asyncio.TimeoutError:
            self.stop()
            raise RuntimeError("cloudflared não respondeu em 30s")

        if not url:
            self.stop()
            raise RuntimeError("cloudflared encerrou sem devolver uma URL")

        self.url = url
        self.ready = False
        self._probe_task = asyncio.create_task(self._probe(url))
        if on_url:
            on_url(url)
        return url

    async def _probe(self, url: str, timeout: float = 60.0) -> None:
        """Espera o endereco realmente responder de fora antes de dizer que
        esta no ar — senao o primeiro convidado toma erro de DNS.

        Duas armadilhas que esta sondagem evita:

        * **Cache negativo do roteador.** O nome acabou de nascer e nao e curinga:
          `*.trycloudflare.com` da NXDOMAIN de verdade. O SOA de trycloudflare.com
          tem minimo de 1800s, entao um NXDOMAIN pego no instante zero fica
          guardado no encaminhador do roteador por **ate 30 minutos** — e a
          propria sondagem era quem envenenava esse cache. Agora ela espera um
          pouco e pergunta por DoH, direto ao 1.1.1.1, sem passar pelo roteador.
        * **Sequestro de NXDOMAIN.** Provedor que devolve a pagina de busca dele
          para dominio inexistente responderia 200 e a sondagem daria o tunel
          como pronto. Por isso conferimos o corpo, nao so o status.
        """
        import aiohttp

        host = url.split("//", 1)[-1].split("/", 1)[0]
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        # O registro nasce junto com o tunel: perguntar no instante zero e o que
        # cria o cache negativo. Da um tempo antes da primeira pergunta.
        await asyncio.sleep(4)
        connector = aiohttp.TCPConnector(resolver=DohResolver(), ttl_dns_cache=0)
        async with aiohttp.ClientSession(connector=connector) as sess:
            while loop.time() < deadline:
                if self.url != url:  # tunel trocado ou derrubado
                    return
                if not await resolve_doh(host):
                    await asyncio.sleep(3)
                    continue
                try:
                    async with sess.get(
                        f"{url}/api/health",
                        timeout=aiohttp.ClientTimeout(total=8),
                        headers={"cache-control": "no-cache"},
                    ) as resp:
                        body = await resp.json(content_type=None)
                        if resp.status == 200 and body.get("ok") is True:
                            self.ready = True
                            self.unconfirmed = False
                            if self.on_ready:
                                self.on_ready()
                            return
                except Exception:
                    pass
                await asyncio.sleep(3)

        # Nao confirmou. O tunel pode muito bem estar funcionando para quem esta
        # fora — o que falhou foi a nossa capacidade de verificar daqui.
        if self.url == url and not self.ready:
            self.unconfirmed = True
            if self.on_ready:
                self.on_ready()

    def stop(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._proc = None
        self.url = None
        self.ready = False
        self.unconfirmed = False
        if self._probe_task:
            self._probe_task.cancel()
            self._probe_task = None
