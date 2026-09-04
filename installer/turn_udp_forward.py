"""Encaminha UDP do Windows para o coturn dentro do WSL2.

Por que isto existe: `netsh interface portproxy` no Windows so encaminha TCP
("No momento apenas TCP tem suporte", segundo o proprio `netsh ... /?`). O TURN
precisa de UDP nas portas de relay — sem excecao, o protocolo nao funciona so
com TCP. Como o WSL2 (modo NAT, o unico compativel com esta maquina) fica
atras de um IP interno que muda a cada reinicio, este processo faz de conta
que e o `netsh portproxy` que falta: escuta cada porta no Windows e repassa os
datagramas para o coturn no WSL, e de volta.

Usa sockets bloqueantes + `select`, nao asyncio: o event loop padrao do
asyncio no Windows (ProactorEventLoop) tem bugs conhecidos e antigos com
`create_datagram_endpoint` — o primeiro datagrama enviado logo apos criar o
transport se perde silenciosamente. `select` sobre sockets crus e o caminho
chato, mas e o que realmente funciona.

Nao precisa de administrador: todas as portas encaminhadas sao > 1024.
"""

from __future__ import annotations

import selectors
import socket
import subprocess
import sys
import time

PORTS = [3478] + list(range(49160, 49167))
DISTRO = "Ubuntu"
RECHECK_SECONDS = 20  # com que frequencia confere se o IP do WSL mudou
IDLE_TIMEOUT = 120  # segundos sem trafego ate fechar o socket de um cliente


def wsl_ip() -> str | None:
    try:
        out = subprocess.run(
            ["wsl.exe", "-d", DISTRO, "-u", "root", "-e", "bash", "-c",
             r"ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}'"],
            capture_output=True, text=True, timeout=10,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def main() -> None:
    target_ip = wsl_ip()
    deadline = time.monotonic() + 30
    while not target_ip and time.monotonic() < deadline:
        time.sleep(2)
        target_ip = wsl_ip()
    if not target_ip:
        print("[turn-forward] WSL nao respondeu — o coturn nao esta acessivel.", file=sys.stderr, flush=True)
        return

    sel = selectors.DefaultSelector()

    # port -> socket que escuta o mundo de fora
    listeners: dict[int, socket.socket] = {}
    for port in PORTS:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setblocking(False)
        s.bind(("0.0.0.0", port))
        listeners[port] = s
        sel.register(s, selectors.EVENT_READ, ("listener", port))

    # (porta_local, endereco_do_cliente) -> { socket, ultimo_uso }
    # cada cliente novo ganha um socket dedicado falando com o coturn, igual a
    # tabela de NAT de uma conexao de verdade faria.
    backchannels: dict[tuple[int, tuple[str, int]], dict] = {}

    def get_backchannel(port: int, client_addr: tuple[str, int]) -> socket.socket:
        key = (port, client_addr)
        entry = backchannels.get(key)
        if entry is None:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setblocking(False)
            s.connect((state["ip"], port))
            entry = {"socket": s, "last": time.monotonic()}
            backchannels[key] = entry
            sel.register(s, selectors.EVENT_READ, ("backchannel", port, client_addr))
        entry["last"] = time.monotonic()
        return entry["socket"]

    def drop_backchannel(key: tuple[int, tuple[str, int]]) -> None:
        entry = backchannels.pop(key, None)
        if entry:
            try:
                sel.unregister(entry["socket"])
            except KeyError:
                pass
            entry["socket"].close()

    state = {"ip": target_ip}
    print(f"[turn-forward] encaminhando para {target_ip} nas portas {PORTS}", flush=True)

    last_check = time.monotonic()
    last_sweep = time.monotonic()

    while True:
        events = sel.select(timeout=5)
        for key, _ in events:
            kind = key.data[0]
            if kind == "listener":
                port = key.data[1]
                try:
                    data, addr = key.fileobj.recvfrom(65536)
                except (BlockingIOError, OSError):
                    continue
                try:
                    get_backchannel(port, addr).send(data)
                except OSError:
                    drop_backchannel((port, addr))
            else:  # backchannel: resposta do coturn de volta para o cliente
                _, port, client_addr = key.data
                try:
                    data = key.fileobj.recv(65536)
                except (BlockingIOError, OSError):
                    continue
                try:
                    listeners[port].sendto(data, client_addr)
                    backchannels[(port, client_addr)]["last"] = time.monotonic()
                except (OSError, KeyError):
                    pass

        now = time.monotonic()
        if now - last_sweep > 30:
            last_sweep = now
            for key in [k for k, e in backchannels.items() if now - e["last"] > IDLE_TIMEOUT]:
                drop_backchannel(key)

        if now - last_check > RECHECK_SECONDS:
            last_check = now
            fresh = wsl_ip()
            if fresh and fresh != state["ip"]:
                print(f"[turn-forward] IP do WSL mudou: {state['ip']} -> {fresh}", flush=True)
                state["ip"] = fresh
                for key in list(backchannels):
                    drop_backchannel(key)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
