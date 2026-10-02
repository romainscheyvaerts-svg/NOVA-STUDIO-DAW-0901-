; Installateur Windows de Nova Studio (Inno Setup 6, compilé par build.py).
; Installation par utilisateur : aucun droit administrateur demandé.

#ifndef AppVersion
  #define AppVersion "1.0.0"
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

[Languages]
Name: "fr"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "Créer un raccourci sur le Bureau"; GroupDescription: "Raccourcis :"

[Files]
Source: "dist\NovaStudio\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Mise à jour propre : on repart d'un dossier _internal vide (anciennes DLL).
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{group}\Nova Studio"; Filename: "{app}\NovaStudio.exe"; Comment: "Nova Studio (ponts ASIO et VST intégrés)"
Name: "{group}\Désinstaller Nova Studio"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Nova Studio"; Filename: "{app}\NovaStudio.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\NovaStudio.exe"; Description: "Lancer Nova Studio"; Flags: nowait postinstall skipifsilent

; Les données (profil WebView2 : connexion, sessions locales ; journaux) sont dans
; %LOCALAPPDATA%\NovaStudio et sont volontairement conservées à la désinstallation.
