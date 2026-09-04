# Garante o WSL/coturn de pe e o redirecionamento TCP:3478 (o unico protocolo
# que o `netsh interface portproxy` desta maquina sabe encaminhar — "No
# momento apenas TCP tem suporte", segundo o proprio `netsh ... /?`).
#
# O UDP (o que realmente importa: e nele que o TURN retransmite audio/video)
# fica por conta do `turn_udp_forward.py`, que roda continuamente — ver esse
# arquivo para o motivo. Este script aqui so cuida de reaplicar o mapeamento
# TCP toda vez que o Windows liga, porque o IP interno do WSL muda a cada
# reinicio (o unico modo de rede compativel com esta maquina e o NAT; o modo
# espelhado conflita com o adaptador OpenVPN/VirtualBox presente aqui).

$distro = "Ubuntu"

wsl.exe -d $distro -u root -e true | Out-Null
Start-Sleep -Seconds 3

$ip = (wsl.exe -d $distro -u root -e bash -c "ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}'").Trim()
if (-not $ip) {
    Write-Output "[sabor-turn] Nao consegui ler o IP do WSL. O tunel TURN nao foi atualizado."
    exit 1
}

netsh interface portproxy delete v4tov4 listenport=3478 listenaddress=0.0.0.0 protocol=tcp | Out-Null
netsh interface portproxy add v4tov4 listenport=3478 listenaddress=0.0.0.0 connectport=3478 connectaddress=$ip protocol=tcp | Out-Null

Write-Output "[sabor-turn] TCP/3478 redirecionado para WSL $ip"
