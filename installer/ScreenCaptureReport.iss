#define MyAppName "Screen Capture Report"
#define MyAppVersion "0.2.0"
#define MyAppExeName "ScreenCaptureReport.exe"

[Setup]
AppId={{AA78F1C8-772D-45B3-8C55-DAAB91AEE518}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\ScreenCaptureReport
DefaultGroupName={#MyAppName}
PrivilegesRequired=lowest
OutputDir=..\dist\installer
OutputBaseFilename=ScreenCaptureReport-Setup-{#MyAppVersion}-x64
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}

[Files]
Source: "..\dist\ScreenCaptureReport\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Tasks]
Name: "autostart"; Description: "Windowsログイン時に起動する"; Flags: unchecked

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ScreenCaptureReport"; ValueData: """{app}\{#MyAppExeName}"""; Tasks: autostart; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{#MyAppName}を起動"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM {#MyAppExeName}"; RunOnceId: "StopApplication"; Flags: runhidden
Filename: "{app}\{#MyAppExeName}"; Parameters: "--prepare-uninstall"; RunOnceId: "PrepareUninstall"; Flags: runhidden

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
var
  DeleteUserData: Boolean;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  DeleteUserData := MsgBox(
    '暗号化された取得データ、ログ、レポート、設定も削除しますか？' + #13#10 +
    '「いいえ」を選ぶと %LOCALAPPDATA%\ScreenCaptureReport に保持します。',
    mbConfirmation,
    MB_YESNO
  ) = IDYES;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  { PurgeCredentials runs before this post-uninstall hook and can briefly
    recreate the data directory. Delete it last when the user requested it. }
  if (CurUninstallStep = usPostUninstall) and DeleteUserData then
  begin
    DelTree(ExpandConstant('{localappdata}\ScreenCaptureReport'), True, True, True);
  end;
end;
