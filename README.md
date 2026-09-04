# Sabor DC

Transmita sua tela e faça a call com os amigos — **o seu PC é o servidor**.
Ninguém instala nada: você manda um link, eles abrem no navegador.

App de desktop em **pywebview** (Windows) que também roda inteiro na web: a
mesma interface que aparece na janela é servida em `http://127.0.0.1`, então dá
para abrir no Chrome/Edge se preferir.

---

## Como funciona

```
                 sinalização (texto, ~1 KB/s)
   convidado  <--------------------------------->  [ seu PC ]
       ^                                            servidor
       |          vídeo + voz direto (WebRTC)        aiohttp
       +--------------------------------------------+
```

O Python só faz o "aperto de mão": ele nunca vê a imagem nem o áudio. A tela
sai da sua GPU direto para cada convidado por WebRTC, com o **encoder de
hardware do próprio navegador** — é por isso que dá para transmitir jogando sem
perder FPS.

Topologia em estrela: cada convidado tem **uma** conexão, com você. A voz — e,
se algum convidado ligar a própria transmissão, a tela dele também — chega até
você e você retransmite para os outros. Seu PC é o servidor pra tudo: vídeo e
áudio de todo mundo passam por ele, mesmo quando quem está transmitindo é um
convidado.

| Peça | O que faz |
| --- | --- |
| `run.py` | Sobe o servidor numa thread e abre a janela |
| `sabor/server.py` | aiohttp: páginas, `/api/*`, `/ws` |
| `sabor/signaling.py` | Sala, participantes, chat, moderação, quem está ao vivo |
| `sabor/net.py` | IP da LAN, certificado local, túnel cloudflared |
| `web/host.html` | Painel de quem hospeda a sala |
| `web/join.html` | Sala de quem assiste (e pode transmitir também) |
| `web/js/grid.js` | Grade de vídeo: um card por transmissão ao vivo |

---

## Instalação

Nesta máquina já está tudo pronto (Python 3.12, a `.venv` com as dependências e
o cloudflared) — é só dar dois cliques em **`start.bat`**.

Em outra máquina, instale o **Python 3.11+**, o **.NET Desktop Runtime**
(o painel roda em cima dele — é diferente do .NET Framework, que já vem no
Windows e não basta sozinho) e, se quiser link de internet, o cloudflared:

```bash
winget install --id Python.Python.3.12
winget install Microsoft.DotNet.DesktopRuntime.8
```

O `start.bat` cria a venv, instala as dependências e abre o app. Na mão:

```bash
python -m venv .venv && .venv\Scripts\pip install -r requirements.txt && .venv\Scripts\python run.py
```

---

## Usando

1. Abra o Sabor DC e clique em **Começar transmissão**. Escolha a tela, a janela do
   jogo ou uma aba — marque *compartilhar áudio* se quiser mandar o som.
2. Copie o **link da sala** e mande para a galera.
3. Quem abrir escolhe um nome, libera o microfone e entra.

**Mais de uma pessoa pode transmitir ao mesmo tempo, na mesma sala, com o
mesmo link.** Qualquer convidado tem o próprio botão de transmitir (ícone de
tela no dock, ou tecla `S`) — a tela dele aparece do lado da do host pra todo
mundo, em cards lado a lado. Clicar num card aumenta ele e encolhe os outros;
clicar de novo desfaz.

Atalhos: `Ctrl+M` liga/desliga o microfone no painel. Na sala: `M` microfone,
`S` transmitir sua tela, `F` tela cheia, `C` chat.

**Quer assistir a transmissão de outra pessoa sem abrir o navegador?** No
painel, em **Link da sala → Assistir uma transmissão**, cole o link que te
mandaram — de outra sala do Sabor DC, sua ou de um amigo — e a própria janela
do app vira a tela de espectador. Como é a mesma janela, entrar assim encerra
a sua transmissão (se tiver uma rolando) e desconecta quem estiver na sua
sala — o app avisa antes. Pra voltar, é só clicar em **"← Meu painel"** no
canto da sala.

### O painel

Três colunas, no formato do Discord:

| Coluna | O que tem |
| --- | --- |
| Esquerda | As salas, com quem está dentro de cada uma, e no rodapé você (nome, sala, microfone, ajustes) |
| Centro | O que está sendo transmitido, os números da transmissão e os controles |
| Direita | Chat, o link pra convidar, e os ajustes |

### Salas e sorteio de times

A lista de pessoas é agrupada por **sala**, como os canais de voz do Discord.
Já vêm três criadas — *Geral*, *Time A* e *Time B* — e dá pra criar mais no
**+**. Clicar no nome de uma sala te move pra ela.

**Sala separa áudio e vídeo.** Você só ouve, e só vê as telas, de quem está na
mesma sala que você. É o ponto todo: dá pra dividir os times antes da partida
sem um time escutar a call do outro.

**Sortear times** embaralha todo mundo que está conectado e joga metade em
cada sala de time — inclusive o host, que também joga. Com número ímpar, um
time fica com uma pessoa a menos. **Reunir** traz todo mundo de volta pra
primeira sala.

Quem está transmitindo continua transmitindo ao mudar de sala; o que muda é
quem recebe. Passando o mouse numa pessoa aparece um seletor pra mover ela
sozinha, sem sortear todo mundo.

### Atualização

Ao abrir o painel, o app pergunta ao GitHub qual é a última versão publicada
em [`john7victor/sabordc`](https://github.com/john7victor/sabordc/releases) e
compara com a que está rodando. Se tiver uma mais nova, ele **já baixa o
instalador sozinho**, em segundo plano, e o aviso na barra lateral vira um
botão de *Instalar* — o download, que é a parte demorada, já está feito.

Instalar continua sendo um clique seu, e não tem como ser diferente: o
instalador precisa de elevação (é ele que cria a regra do Firewall), então o
UAC do Windows sempre vai aparecer. Também é melhor assim — trocar de versão
sozinho fecharia o app no meio de uma transmissão.

Duas proteções que valem citar:

* **O download espera você sair do ar.** Puxar ~80 MB durante uma transmissão
  disputaria banda e disco justamente com o que está acontecendo. Se você
  estiver transmitindo, ele adia e começa quando você encerrar.
* **Só baixa de um lugar.** O método exposto ao painel recusa qualquer
  endereço que não comece com a URL de releases deste repositório — sem isso,
  um painel comprometido teria como fazer o app baixar e rodar qualquer
  executável da internet.

O repositório é público de propósito: assim a consulta funciona sem token
nenhum. Num repositório privado, o app precisaria carregar um segredo embutido
pra conseguir perguntar — e qualquer pessoa extrai isso de um `.exe`.

Sem internet, com o GitHub fora do ar ou sem release publicada, a checagem
falha em silêncio: não é assunto que justifique atrapalhar quem só quer
transmitir.

### Amigos em outra cidade (o caso normal)

1. **Abra o link público** — vem ligado por padrão, em *Ajustes → Rede*. Espere
   o status virar **"No ar"**.
2. Mande o link. Eles abrem no navegador, sem instalar nada.
3. Confira na aba **Pessoas**: cada um mostra `conectado` ou `falhou`.

O túnel carrega **só a sinalização**. O vídeo e a voz vão direto do seu PC para
o de cada um — o túnel não vira gargalo e não vê a sua tela.

**Antes de convidar, rode *Ajustes → Rede → Testar minha rede*.** Ele pergunta
o seu endereço público a **dois servidores STUN de provedores diferentes** e
compara a porta que cada um viu. É essa comparação — e não a porta local — que
diz a verdade:

| Veredito | O que significa |
| --- | --- |
| Mapeamento independente do destino ("cone") | Funciona para praticamente todo mundo |
| **NAT simétrico** | Cada destino ganha uma porta nova: **ninguém** conecta direto. TURN obrigatório |
| Endereço em `100.64.0.0/10` | Você está atrás de CGNAT, sem porta para abrir |
| Nenhum STUN respondeu | Firewall bloqueando UDP; nada vai conectar |

Se **alguém específico** aparecer como `falhou`, o problema é a rede *dele*.
Se **todo mundo** falha, o problema é o seu NAT.

> Não embuti nenhum TURN público de graça: testei o Open Relay (o mais citado)
> e ele está fora do ar. Um TURN que não responde é pior que nenhum, porque
> atrasa a negociação sem resolver.

### Se a sua internet é CGNAT

CGNAT é o provedor te colocando atrás do NAT dele: o seu roteador não tem IPv4
público, e não existe porta para abrir. Separe as duas metades do problema —
elas têm respostas diferentes:

**A sinalização (o link) já está resolvida.** O túnel do cloudflared é uma
conexão de *saída* do seu PC para a Cloudflare. CGNAT não atrapalha saída. O
link `https://algo.trycloudflare.com` funciona igual, e é só isso que a pessoa
precisa receber.

**A mídia é onde o CGNAT morde.** O WebRTC tem exatamente três caminhos: mesma
rede local, furação de buraco com STUN, ou retransmissão por TURN. Sob CGNAT o
segundo caminho depende de como o provedor mapeia as portas:

* **CGNAT de mapeamento independente do destino** — a furação funciona, e você
  não precisa de mais nada. É o caso da maioria.
* **CGNAT simétrico** — a furação não fecha para ninguém. **Só TURN resolve.**
  Não existe truque, configuração de roteador ou codec que contorne isso.

O teste de rede diz em qual dos dois você está. Se for o segundo, ligue também
*"Ir direto pelo TURN"*: sem isso cada convidado espera a negociação direta
estourar (uns 10 s de tela preta) antes de cair no relay.

**IPv6 é a saída barata.** CGNAT é um problema de IPv4 — no IPv6 cada máquina
tem endereço próprio. Se você e a outra pessoa tiverem IPv6, a conexão é direta
e o CGNAT some da história. Vale ligar o IPv6 no roteador; só não dá para
contar com ele, porque não dá para exigir IPv6 de quem vai assistir.

**Antes do TURN, olhe o seu próprio roteador.** NAT simétrico nem sempre vem do
provedor — em muito roteador é configuração. No **pfSense**, o *Outbound NAT*
automático embaralha a porta de origem, e é isso que o diagnóstico mede como
simétrico. A correção:

> *Firewall → NAT → Outbound* → **Hybrid Outbound NAT** → **Add**: Interface
> `WAN`, Source = a sua rede LAN, e marque **Static Port** → Save + Apply.

Feito isso, rode o diagnóstico de novo: se o veredito virar "cone", a conexão
direta voltou e você só vai precisar de TURN para os amigos que estiverem, eles
próprios, em NAT simétrico. Em roteador comum o equivalente costuma se chamar
*Full Cone NAT*, *Endpoint-Independent Mapping* ou *NAT tipo 2/aberto*.

**Onde arrumar um TURN.** O relay carrega o vídeo inteiro, então o custo é
banda, não CPU: uma transmissão de 6 Mb/s com 4 pessoas passa ~11 GB por hora
pelo relay.

| Opção | Observação |
| --- | --- |
| **Cloudflare Realtime** | Suportado direto no app (abaixo). Sem instalar nada, sem abrir porta |
| `coturn` numa VPS | Mais barato por GB se o volume crescer. Use `use-auth-secret` |
| Twilio / Metered / Xirsys | Funcionam, mas cobram por GB — caro para vídeo |

#### Cloudflare Realtime (o caminho curto)

1. No painel da Cloudflare: **Realtime → TURN → Create**. Guarde o *Turn Token
   ID* e a chave.
2. No Sabor DC: *Ajustes → Rede → Servidor TURN* → escolha **Cloudflare Realtime**
   e cole os dois campos → **Salvar TURN**.
3. Clique em **Testar o TURN agora**. Ele pede uma credencial de verdade e
   tenta juntar um candidato de relay — as duas metades precisam passar.

O par que você colou **não sai deste PC**. A cada pessoa que entra, o app pede à
Cloudflare um usuário e senha temporários e manda só isso para o navegador dela;
a credencial expira sozinha. Os seus STUN continuam na lista junto com os da
Cloudflare, para o diagnóstico ter dois provedores distintos com que medir o NAT.

Com um servidor próprio, o campo **segredo compartilhado** (o `use-auth-secret`
do coturn) faz a mesma coisa. Sem ele, a senha fixa do seu relay viaja junto com
o link para qualquer um que entre na sala.

### Um link que não muda

O `trycloudflare` sorteia um endereço novo a cada vez que você abre o túnel.
Para ter sempre o mesmo link, use um **túnel nomeado** com um domínio seu na
Cloudflare (`cloudflared tunnel create` + `cloudflared tunnel route dns`). Além
de estável, ele evita de vez o problema de DNS descrito lá embaixo, porque o
registro passa a existir antes de alguém perguntar por ele.

### Os três links

| Escopo | Quando usar |
| --- | --- |
| **Este PC** | Testar você mesmo, numa outra aba |
| **Rede local** | Todo mundo na mesma casa/rede — `https://SEU-IP:8771` |
| **Internet** | Amigos em qualquer lugar (precisa do túnel) |

O link de rede local usa **HTTPS com certificado autoassinado**: o navegador
mostra um aviso e a pessoa clica em "Avançado → continuar". Isso é necessário
porque nenhum navegador libera microfone fora de um contexto seguro.

### Link de internet

Em **Ajustes → Rede → Abrir link público**, o Sabor DC sobe um túnel e te dá um
endereço `https://algo.trycloudflare.com`. Sem abrir porta no roteador.

> **Espere o status virar "No ar".** O endereço aparece na hora, mas o DNS do
> nome novo leva alguns segundos para propagar. Enquanto isso o app mostra
> *"aguarde o DNS propagar"* — se mandar o link antes, a primeira pessoa toma
> erro de "site não encontrado".

O túnel carrega só a sinalização — o vídeo continua indo direto. Em algumas
redes (4G, Wi-Fi corporativo) a conexão direta não fecha; nesse caso preencha um
**servidor TURN** em Ajustes → Rede.

Se o cloudflared não estiver instalado:

```bash
winget install --id Cloudflare.cloudflared
```

O app procura o executável no PATH, nas pastas padrão do winget e **ao lado do
`run.py`** — então dá para largar um `cloudflared.exe` na pasta do projeto e
funciona sem instalar nada.

---

## Qualidade

| Ajuste | Efeito |
| --- | --- |
| Resolução | 720p / 1080p / 1440p / nativa |
| Taxa | 30 ou 60 fps |
| Teto de banda | Por espectador — o painel mostra quanto de upload isso pede |

A escolha aparece num diálogo toda vez que você começa a transmitir — HD, Full
HD, 2K ou Nativa, e 30 ou 60 fps — junto com o que aquilo custa de banda.

**O que isso muda no FPS do jogo.** A qualidade escolhida vira um teto de
**altura** na captura (`height: { max: 1080 }`, por exemplo). Isso importa
porque a parte cara é capturar: num monitor 1440p, transmitir em 720p sem esse
teto capturaria 1440p e só encolheria depois, gastando GPU à toa. Só a altura
é limitada, nunca largura e altura juntas — pedir as duas define uma proporção
alvo e faz o navegador **cortar** a imagem quando a fonte tem outra (é o que
acontecia com quem joga em resolução esticada).

**Nativa** não põe teto nenhum: captura sua tela como ela é. É a mais pesada.

Trocar a resolução ou a taxa também ajusta o teto de banda sozinho, pro valor
recomendado daquela qualidade — dá pra baixar na mão depois, mas o padrão já
evita a causa mais comum de queda de fps: banda baixa demais pra qualidade
escolhida (o navegador prioriza manter os quadros e sacrifica outra coisa, o
que quase nunca é visível como imagem ruim, e sim como engasgo).

Cada espectador é um fluxo independente. Com 6 Mb/s × 4 pessoas você precisa de
~24 Mb/s de upload. Se a internet apertar, baixe o teto ou a resolução.

> **Fone de ouvido.** Se você compartilhar o áudio do sistema e ouvir a galera
> pelas caixas, a voz deles volta na transmissão.

### Desempenho (por que não engasga)

O selo em cima da prévia mostra `H264 · GPU` quando está tudo certo. Duas
decisões fazem esse número:

**H.264 em vez de VP8.** O padrão do Chrome/WebView2 para WebRTC é VP8, que no
Windows **não tem encoder de hardware**: 1080p60 vira trabalho de CPU brigando
com o jogo. O Sabor DC reordena os codecs para pedir H.264, que cai no encoder
dedicado da GPU (NVENC, AMD VCE, Intel QuickSync) e custa quase nada. Todos os
codecs continuam na lista, só mudou a ordem — se o outro lado não aceitar H.264,
a negociação cai para VP8 sozinha.

**`contentHint = "motion"`.** Uma captura de tela é otimizada por padrão para
texto parado: prioriza nitidez e sacrifica quadros. Para jogo é o contrário do
que se quer. Com `motion`, o encoder mantém a taxa de quadros e abre mão de
detalhe nas cenas de movimento.

O que o selo diz:

| Selo | Significado |
| --- | --- |
| `H264 · GPU` | Encoder de hardware. É o esperado. |
| `H264 · CPU` | Sem encoder de hardware disponível — baixe para 1080p30 ou 720p60. |
| `· CPU no limite` | A codificação não acompanha. Baixe resolução ou taxa. |
| `· banda no limite` | Seu upload não dá conta. Baixe o teto de banda. |

**Ainda engasga?** Nesta ordem:

1. **Deixe a prévia desligada** (o ícone de olho na barra de baixo). Ela
   desenha a captura dentro da janela do app, disputando GPU com o jogo — por
   isso vem desligada por padrão, e o diálogo de qualidade pergunta antes de
   cada transmissão. Não afeta nada do que os espectadores veem.
2. Baixe para **1080p30** — metade do trabalho de codificação.
3. Baixe para **720p60** se você prefere fluidez a nitidez.
4. Rode o jogo em **janela sem bordas** em vez de tela cheia exclusiva: em tela
   cheia exclusiva o Windows dá prioridade ao jogo e a captura sofre.

Distinguir os dois casos: se **o jogo** engasga, é a codificação (siga a lista
acima). Se só **a prévia** engasga mas os espectadores estão fluidos, ignore —
é só a janela do app, e desligar a prévia resolve.

---

## Moderação

Na aba **Pessoas** do painel: silenciar uma pessoa, remover, silenciar todos ou
trancar a sala. **Renovar o link** (ícone ↻) invalida o endereço antigo — quem
tiver o link velho para de entrar.

---

## Problemas

**O app fecha sozinho ao abrir, com um erro do Python numa janela ("Failed to
resolve Python.Runtime.Loader.Initialize" ou parecido).** Falta o **.NET
Desktop Runtime** — o painel roda em cima dele, e é diferente do .NET
Framework que já vem instalado no Windows. Instale com:

```bash
winget install Microsoft.DotNet.DesktopRuntime.8
```

O instalador (`.exe` com Inno Setup) já verifica isso antes de instalar; só a
versão portátil (pasta `.zip`) não tem como avisar antes — por isso o app
também confere sozinho ao abrir e mostra uma mensagem clara em vez de travar.

**O jogo não aparece na lista ao escolher "Janela" no seletor de tela.** Jogo
em **tela cheia exclusiva** não tem uma "janela" que o Windows consiga listar
— ele toma conta do monitor direto, por fora do que o seletor enxerga. Duas
saídas: escolha **"Tela inteira"** em vez de "Janela" (sempre funciona,
mesmo em tela cheia exclusiva), ou troque o jogo para **tela cheia sem
bordas** (*Borderless/Fullscreen Windowed*) nas opções de vídeo dele — aí ele
vira uma janela normal e passa a aparecer na lista. É o mesmo ajuste que já
ajuda a performance (ver "Desempenho" mais abaixo).

**Marquei “compartilhar áudio” e ninguém ouve.** Olhe o ícone de som na barra
de baixo do painel: ele agora diz a verdade sobre o que está sendo enviado —
fica **vermelho** quando a captura veio sem faixa de áudio nenhuma, e o app
avisa na hora de escolher a fonte. Nesse caso não adianta clicar nele; é
preciso encerrar e escolher a fonte de novo. Duas causas comuns:

* **Compartilhar uma janela.** Windows não sabe isolar o áudio de uma janela
  só, então esse modo costuma vir sem som. O app agora pede explicitamente o
  áudio do sistema junto (`windowAudio: "system"`), mas se ainda vier mudo,
  compartilhe a **tela inteira** — nela o áudio funciona sempre.
* **A caixa não estava marcada.** É fácil passar batido: ela fica no canto de
  baixo do seletor, e some quando a aba escolhida é "Janela" em alguns
  runtimes do WebView2.

**A janela do app não abre o seletor de tela.** O seletor nativo do WebView2
(Janela / Tela Inteira + "compartilhar áudio do sistema") funciona normalmente
em runtimes atuais. Se o seu for antigo e não abrir, *Ajustes → Abrir painel no
navegador* leva o painel para o Chrome/Edge com o seletor de lá, e todo o resto
continua igual. Para forçar a tela inteira sem seletor nenhum:

```bash
set SABOR_AUTOSELECT=1 && python run.py
```

**O link de rede local aponta para um IP que ninguém alcança.** Acontecia em
máquina com VPN: o app descobria o IP local abrindo um socket para
`10.255.255.255`, endereço que casa com a rota da própria VPN, e acabava
anunciando o IP do túnel. Agora ele mira um endereço público, o que faz o
sistema escolher a interface da rota padrão — a mesma por onde os outros chegam.

**Convidado entra mas não fala.** Ele abriu por `http://` da LAN. Mande o link
`https://` — sem contexto seguro o navegador bloqueia o microfone.

**"Não consegui conectar".** A conexão direta não fechou. Configure um TURN em
Ajustes → Rede.

**Porta ocupada.** O app procura a próxima porta livre sozinho a partir da 8770.

**“Só funcionou quando fixei um DNS no PC.”** É cache negativo de DNS, e a
culpa era do próprio app.

O nome `algo.trycloudflare.com` **não é curinga**: ele passa a existir no
instante em que o túnel sobe. O `trycloudflare.com` tem SOA com mínimo de
**1800 s**, ou seja: um `NXDOMAIN` colhido cedo demais fica guardado por **até
30 minutos** em qualquer resolvedor que faça cache — inclusive o `dnsmasq` que
o seu roteador roda quando você usa o IP dele como DNS.

E quem colhia esse `NXDOMAIN` era a sondagem do app, que perguntava pelo nome no
segundo zero, pelo resolvedor do sistema. Ela envenenava o cache do roteador e
depois passava um minuto lendo a própria mentira — daí o status travado em
*"aguarde o DNS propagar"*. Trocar o DNS da máquina para o 1.1.1.1 resolvia
porque dava um cache limpo, não porque o Google/Cloudflare seja "melhor".

O que mudou:

* A sondagem espera alguns segundos antes da primeira consulta.
* Ela resolve por **DNS-sobre-HTTPS direto com o 1.1.1.1**, sem passar pelo
  resolvedor do sistema — então o app nunca mais envenena o cache do roteador.
* Ela confere o **corpo** da resposta, não só o status 200: provedor que
  sequestra `NXDOMAIN` e devolve página de busca não engana mais o app.
* Antes de subir o `cloudflared`, o app testa se o DNS da máquina resolve
  `api.trycloudflare.com`. Se não resolver, ele diz isso — em vez de morrer com
  *"não respondeu em 30s"*.
* *Ajustes → Rede → Testar minha rede* agora compara o DNS do sistema com o
  1.1.1.1 e mostra qual servidor está em uso.

Se mesmo assim um convidado tomar "site não encontrado" enquanto os outros
entram, é o resolvedor **dele** que guardou o nome como inexistente: ele abriu o
link cedo demais. Espere o status virar **"No ar"** antes de mandar o link, ou
use um túnel nomeado com domínio próprio.

Logs detalhados: `set SABOR_DEBUG=1` antes de rodar abre o DevTools da janela.

---

## Gerar o instalador

```bash
build.bat
```

Faz tudo: gera o ícone, empacota com PyInstaller e monta o instalador com Inno
Setup. Saem duas coisas em `dist\`:

| Saída | O que é |
| --- | --- |
| `Sabor DC-<versão>-setup.exe` | Instalador (~87 MB) — atalhos, firewall, desinstalador, e o .NET Desktop Runtime embutido |
| `SABOR\` (em `%LOCALAPPDATA%\SABOR-build\dist`) | Versão portátil — copia a pasta e roda o `SABOR.exe` |

A versão sai de três lugares que precisam concordar: `sabor/__init__.py`
(`__version__`, é o que o app compara com o GitHub), `installer/sabor.iss`
(`AppVersion`) e `installer/version_info.txt` (as propriedades do `.exe`).

### Publicando uma versão

Depois de bumpar os três e rodar o `build.bat`, a release vai pro GitHub com
os dois arquivos anexados — o `.exe` é o que o auto-update baixa, então ele
precisa estar lá:

```bash
gh release create v1.2.0 \
  "dist/Sabor DC-1.2.0-setup.exe#Instalador (Windows)" \
  "dist/Sabor DC-1.2.0-portatil.zip#Versão portátil" \
  --title "Sabor DC 1.2.0" --notes "o que mudou"
```

Se o `gh` reclamar de login: o token que o Git guarda no Credential Manager
serve, mas não tem o escopo que o `gh auth login` exige. Passe por variável de
ambiente que funciona:

```bash
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p')
GH_TOKEN="$TOKEN" gh release create ...
```

Precisa das ferramentas de build uma vez:

```bash
winget install --id JRSoftware.InnoSetup
```

### O que o instalador faz

- Instala em `Arquivos de Programas\Sabor DC`, com atalho no Menu Iniciar e
  (opcional) na área de trabalho.
- **Libera o app no Firewall do Windows** — só nos perfis *privado* e *domínio*.
  Em rede pública (café, aeroporto) continua fechado. Sem essa regra o link da
  rede local não abre na máquina dos outros.
- Verifica o **WebView2 Runtime** antes de instalar. Sem ele o app não abre; o
  Windows 11 já vem com ele, no Windows 10 o instalador manda você baixar.
- Oferece instalar o **cloudflared via winget** (desmarcado por padrão).
- Ao desinstalar, remove a regra de firewall e pergunta se apaga suas
  configurações.

O instalador pede elevação (UAC) — é o que permite criar a regra de firewall.
Ele **não é assinado digitalmente**, então o SmartScreen vai mostrar
"Windows protegeu o computador" na primeira execução: *Mais informações →
Executar assim mesmo*. Para sumir com esse aviso seria preciso um certificado de
assinatura de código (pago).

Quer embutir o cloudflared dentro do instalador em vez de baixar via winget?
Largue um `cloudflared.exe` em `installer\` antes de rodar o `build.bat` — o
componente aparece sozinho. Fica ~54 MB maior, e a redistribuição do binário é
sua responsabilidade (licença Apache-2.0).

---

Configurações e certificado ficam em `%APPDATA%\SABOR`.
