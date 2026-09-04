; Instalador do Sabor DC — Inno Setup 6
; Compile com:  ISCC.exe installer\sabor.iss   (ou use build.bat)

#define AppName      "Sabor DC"
#define AppVersion   "1.5.0"
#define AppExe       "SABOR.exe"
#define AppPublisher "Sabor DC"
; O build.bat copia o cloudflared para ca quando encontra um. Se nao houver,
; o componente do tunel simplesmente nao existe neste instalador.
#define HaveCloudflared FileExists(AddBackslash(SourcePath) + "cloudflared.exe")
; Instalador oficial da Microsoft, baixado uma vez e deixado aqui (nao muda
; com frequencia). Se nao houver, o instalador cai de volta em avisar e
; mandar a pessoa instalar na mao — ver InitializeSetup.
#define HaveDotNetRuntime FileExists(AddBackslash(SourcePath) + "windowsdesktop-runtime-win-x64.exe")
; De onde vem o app empacotado. O build.bat aponta para fora do OneDrive,
; que trava arquivos no meio do build. Passe com: ISCC /DDistDir=<caminho>
#ifndef DistDir
  #define DistDir "..\dist\SABOR"
#endif

[Setup]
AppId={{8F3C1A54-9B2E-4D77-9A0C-2E6B5D71C4A1}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=no
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName} {#AppVersion}
OutputDir=..\dist
OutputBaseFilename={#AppName}-{#AppVersion}-setup
SetupIconFile=sabor.ico
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; admin para conseguir criar as regras de firewall da rede local
PrivilegesRequired=admin
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar um atalho na area de trabalho"; GroupDescription: "Atalhos:"
Name: "firewall"; Description: "Liberar no Firewall do Windows (necessario para o link da rede local)"; GroupDescription: "Rede:"
Name: "cloudflared"; Description: "Instalar o cloudflared via winget (link de internet)"; GroupDescription: "Rede:"; Flags: unchecked

[Components]
Name: "core"; Description: "Sabor DC"; Types: full compact custom; Flags: fixed
#if HaveCloudflared
Name: "tunnel"; Description: "cloudflared (link de internet, sem abrir porta no roteador)"; Types: full
#endif

[Files]
Source: "{#DistDir}\{#AppExe}"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "{#DistDir}\*"; DestDir: "{app}"; Components: core; Excludes: "{#AppExe}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\README.md"; DestDir: "{app}"; Components: core; Flags: ignoreversion isreadme
#if HaveCloudflared
Source: "cloudflared.exe"; DestDir: "{app}"; Components: tunnel; Flags: ignoreversion
Source: "cloudflared-LICENSE.txt"; DestDir: "{app}"; Components: tunnel; Flags: ignoreversion skipifsourcedoesntexist
#endif
#if HaveDotNetRuntime
; so pra {tmp}: e um instalador de terceiros, nao faz parte do app instalado
; (o Inno apaga {tmp} sozinho ao terminar). A execucao de verdade, la embaixo
; em [Run], e que checa se a maquina ja tem o runtime antes de rodar isso.
Source: "windowsdesktop-runtime-win-x64.exe"; DestDir: "{tmp}"; Components: core; Flags: deleteafterinstall
#endif

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Desinstalar {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
#if HaveDotNetRuntime
; primeiro de tudo: sem isso o app nem abre. "Check" pula se ja tiver.
Filename: "{tmp}\windowsdesktop-runtime-win-x64.exe"; Parameters: "/install /quiet /norestart"; \
  StatusMsg: "Instalando o .NET Desktop Runtime..."; \
  Flags: waituntilterminated; Check: NeedsDotNetRuntime
#endif
; remove uma regra antiga antes de recriar, senao reinstalar duplica
Filename: "{sys}\netsh.exe"; \
  Parameters: "advfirewall firewall delete rule name=""SABOR"""; \
  Flags: runhidden waituntilterminated; Tasks: firewall
; so perfis privado/dominio: em rede publica (cafe, aeroporto) fica fechado
Filename: "{sys}\netsh.exe"; \
  Parameters: "advfirewall firewall add rule name=""SABOR"" dir=in action=allow program=""{app}\{#AppExe}"" enable=yes profile=private,domain"; \
  Flags: runhidden waituntilterminated; Tasks: firewall
; "& exit /b 0" engole a falha: se o winget nao existir, a instalacao segue
Filename: "{cmd}"; \
  Parameters: "/c winget install --id Cloudflare.cloudflared --accept-package-agreements --accept-source-agreements --silent & exit /b 0"; \
  StatusMsg: "Instalando o cloudflared..."; \
  Flags: runhidden waituntilterminated; Tasks: cloudflared
Filename: "{app}\{#AppExe}"; Description: "Abrir o {#AppName} agora"; \
  Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\netsh.exe"; \
  Parameters: "advfirewall firewall delete rule name=""SABOR"""; \
  Flags: runhidden; RunOnceId: "RemoverRegraFirewall"

[Code]

// --- WebView2: o app nao roda sem o runtime -------------------------------
function WebView2Installed: Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  if Result then
    Result := (Version <> '') and (Version <> '0.0.0.0');
end;

// --- .NET Desktop Runtime: o painel roda em pythonnet, que precisa dele --
// (diferente do .NET Framework, que ja vem no Windows e NAO basta sozinho
// a partir do pythonnet 3.x — sem isso o app abre e fecha com um erro
// do Python em vez de dizer o que falta instalar).
function DotNetDesktopRuntimeInstalled: Boolean;
begin
  Result := DirExists(ExpandConstant('{pf}\dotnet\shared\Microsoft.WindowsDesktop.App'));
end;

// "Check:" em [Run] só aceita o NOME de uma função — não dá pra usar "not
// DotNetDesktopRuntimeInstalled" ali direto, por isso este embrulho.
function NeedsDotNetRuntime: Boolean;
begin
  Result := not DotNetDesktopRuntimeInstalled;
end;

function InitializeSetup: Boolean;
var
  Erro: Integer;
begin
  Result := True;
  if not WebView2Installed then
  begin
    if MsgBox('O Sabor DC precisa do WebView2 Runtime da Microsoft, que nao foi encontrado' + #13#10 +
              'nesta maquina. Ele e gratuito e ja vem no Windows 11.' + #13#10 + #13#10 +
              'Quer abrir a pagina de download agora? Instale o WebView2 e' + #13#10 +
              'depois rode este instalador de novo.',
              mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/',
                '', '', SW_SHOW, ewNoWait, Erro);
    Result := False;
    Exit;
  end;

  // Se o instalador do .NET Desktop Runtime veio embutido, [Run] cuida disso
  // sozinho mais tarde (silencioso) — so bloqueia aqui quando NAO tem como.
#if !HaveDotNetRuntime
  if not DotNetDesktopRuntimeInstalled then
  begin
    if MsgBox('O Sabor DC tambem precisa do .NET Desktop Runtime da Microsoft, que nao' + #13#10 +
              'foi encontrado nesta maquina — e diferente do .NET Framework, que ja vem' + #13#10 +
              'no Windows e nao basta sozinho.' + #13#10 + #13#10 +
              'Quer abrir a pagina de download agora? Escolha "Desktop Runtime" (x64) e' + #13#10 +
              'depois rode este instalador de novo.',
              mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://dotnet.microsoft.com/download/dotnet/8.0',
                '', '', SW_SHOW, ewNoWait, Erro);
    Result := False;
  end;
#endif
end;

// --- desinstalacao: oferecer apagar configuracoes --------------------------
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Dados: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Dados := ExpandConstant('{userappdata}\SABOR');
    if DirExists(Dados) then
      if MsgBox('Apagar tambem suas configuracoes, o certificado local e o cache?' + #13#10 +
                Dados, mbConfirmation, MB_YESNO) = IDYES then
        DelTree(Dados, True, True, True);
  end;
end;
