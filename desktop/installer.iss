; Installateur Windows de Nova Studio (Inno Setup 6, compilé par build.py).
; Installation par utilisateur : aucun droit administrateur demandé.
; Le runtime Microsoft Edge WebView2 est installé automatiquement s'il manque (rare : présent
; d'office sur Windows 11 et sur les Windows 10 à jour), par l'installateur officiel de Microsoft
; (« Evergreen Bootstrapper », téléchargé et vérifié par build.py ; Internet requis dans ce cas).

#ifndef AppVersion
  #define AppVersion "1.1.0"
#endif

[Setup]
AppId={{6F1C2B7E-8E43-4C2A-9F57-2D7A4E0B9C11}
AppName=Nova Studio
AppVersion={#AppVersion}
AppVerName=Nova Studio {#AppVersion}
AppPublisher=Make Music
AppPublisherURL=https://studiomakemusic.com
AppSupportURL=https://studiomakemusic.com
VersionInfoVersion={#AppVersion}
VersionInfoCompany=Make Music
VersionInfoProductName=Nova Studio
VersionInfoDescription=Installation de Nova Studio
DefaultDirName={localappdata}\Programs\Nova Studio
DefaultGroupName=Nova Studio
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=dist
OutputBaseFilename=NovaStudioSetup
SetupIconFile=assets\nova.ico
UninstallDisplayIcon={app}\NovaStudio.exe
UninstallDisplayName=Nova Studio
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes
WizardStyle=modern
; L'appli ouverte bloque la mise à jour : on demande de la fermer (même nom que dans nova_desktop.py).
AppMutex=NovaStudioDesktopMutex
CloseApplications=yes
RestartApplications=no
#ifdef SIGN
; build.py passe /Snovasign=<commande signtool> quand un certificat est configuré (NOVA_SIGN_*)
SignTool=novasign
SignedUninstaller=yes
#endif

[Languages]
Name: "fr"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "Créer un raccourci sur le Bureau"; GroupDescription: "Raccourcis :"

[Files]
Source: "dist\NovaStudio\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "vendor\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedsWebView2

[InstallDelete]
; Mise à jour propre : on repart d'un dossier _internal vide (anciennes DLL).
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{group}\Nova Studio"; Filename: "{app}\NovaStudio.exe"; Comment: "Nova Studio (ponts ASIO et VST intégrés)"
Name: "{group}\Désinstaller Nova Studio"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Nova Studio"; Filename: "{app}\NovaStudio.exe"; Tasks: desktopicon

[Run]
; Runtime WebView2 absent : installation silencieuse (par utilisateur si l'installation l'est).
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installation du composant Microsoft Edge WebView2 (affichage de Nova Studio)…"; Flags: waituntilterminated; Check: NeedsWebView2
Filename: "{app}\NovaStudio.exe"; Description: "Lancer Nova Studio"; Flags: nowait postinstall skipifsilent

; Les données (profil WebView2 : connexion, sessions locales ; journaux) sont dans
; %LOCALAPPDATA%\NovaStudio et sont volontairement conservées à la désinstallation.

[Code]
// Runtime WebView2 présent ? (clés documentées par Microsoft : machine 32/64 bits ou utilisateur)
function WebView2Version(Root: Integer; Key: String): String;
begin
  if not RegQueryStringValue(Root, Key, 'pv', Result) then
    Result := '';
end;

function NeedsWebView2: Boolean;
var
  V: String;
begin
  V := WebView2Version(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}');
  if (V = '') or (V = '0.0.0.0') then
    V := WebView2Version(HKLM64, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}');
  if (V = '') or (V = '0.0.0.0') then
    V := WebView2Version(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}');
  Result := (V = '') or (V = '0.0.0.0');
  if Result then
    Log('WebView2 absent : installation par MicrosoftEdgeWebview2Setup.exe')
  else
    Log('WebView2 présent : ' + V);
end;
