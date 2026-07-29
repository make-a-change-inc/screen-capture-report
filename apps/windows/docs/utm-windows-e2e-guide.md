# UTMで行うWindows版・対話E2E検証ガイド

このガイドは、別のMac上のUTMでWindowsを起動し、`Screen Capture Report` Windows版を人の操作で確認するための手順書です。

- 対象ブランチ: `blushup-windows`
- 対象コミット: `d04728c66491d6256127e296250f03d432b6e02e`
- 既存チェックリスト: [Windows 10/11 E2E Evidence Checklist](./windows-e2e-checklist.md)
- 検証データ: 必ず架空の画面、架空の従業員ID、テスト専用メールを使用する
- 禁止事項: 実従業員データ、実顧客データ、個人のメールやパスワード画面を映さない

## 0. 最初に確認すること

### Macの種類によるWindowsの選び方

Macの「Appleメニュー > このMacについて」を開き、`チップ`または`プロセッサ`を確認します。

| Mac | UTMへ入れるWindows | この検証での扱い |
|---|---|---|
| Apple Silicon（M1/M2/M3/M4など） | Windows 11 ARM64 | 推奨。Windows 11内蔵のx64エミュレーションで本アプリのx64版を動かす |
| Intel Mac | Windows 11 x64 | 推奨。x64版をそのまま検証できる |
| Intel MacでWindows 10も確認する場合 | Windows 10 22H2 x64 | Windows 10互換性確認用の別VMとして用意する |

注意:

- Windows 10 ARMはx64アプリの検証先にしません。
- Apple Silicon上のWindows 11 ARM64は有用な互換性検証ですが、ネイティブのWindows 10/11 x64環境と完全に同一ではありません。最終的に要件どおりのx64環境証跡が必要なら、Intel MacのUTMまたは物理x64 Windowsでも追加確認します。
- UTMでApple Silicon上にx64 Windowsそのものをエミュレーションすることもできますが、非常に遅くなります。最初の検証ではWindows 11 ARM64を使います。

参考:

- [UTM公式 Windows 11インストールガイド](https://docs.getutm.app/guides/windows/)
- [UTM公式 Windows Guest Tools](https://docs.getutm.app/guest-support/windows/)
- [Microsoft: Windows 11 on Armのx64エミュレーション](https://learn.microsoft.com/windows/arm/apps-on-arm-x86-emulation)

### キーや外部サービスの要否

| 項目 | 最初から必要か | 説明 |
|---|---:|---|
| Windowsライセンスキー | いいえ | インストール時は「プロダクトキーがありません」で進め、後から認証できる |
| Gemini APIキー | 基本操作だけなら不要 | ダミー値でオンボーディング、取得、暗号化、失敗キューまで確認できる。実解析、日報内容、精度、原価の合格判定にはテスト用の実キーが必要 |
| SMTPアカウント | いいえ | 実メール送信と送信リトライを確認するときだけ必要 |
| AWS / GCP / Tailscale | 不要 | このUTM検証では使用しない |

### 合格記号

各項目は次のいずれかで記録します。

- `PASS`: 操作と期待結果の両方を証跡で確認した
- `FAIL`: 期待結果と異なった
- `BLOCKED`: UTMの複数画面制約、未提供のテストキーなどで実施できなかった
- `NOT RUN`: まだ操作していない

`BLOCKED`や`NOT RUN`を`PASS`として扱わないでください。

### 迷ったら、この順番で進める

初回は次の順番だけ意識してください。各操作の詳細は後続のStepにあります。

1. UTMへWindows 11を入れる。
2. GitHub Actionsのインストーラーをダウンロードし、SHA-256を確認する。
3. インストールして、同意前に画像が作られないことを確認する。
4. Gemini欄へダミー値を入れ、トレイ、一時停止、60秒周期、除外、離席、ロック、再起動を確認する。
5. テスト用Geminiキーを用意できたら、実解析、失敗キュー復旧、日報、精度、原価を確認する。
6. テスト用SMTPを用意できたら、メール失敗と自動再送を確認する。
7. アンインストール後、証跡をzipにしてMacへ戻す。

目安時間:

- UTMとWindows準備: 60〜90分
- インストールと基本E2E: 60〜90分。5分離席や再起動待ちを含む
- GeminiライブE2E: 30〜60分
- SMTPと前週レポート: テスト用環境・データの準備状況による

---

## Phase 1: UTMとWindows 11を準備する

### Step 1. UTMをインストールする

1. Macで[UTM公式サイト](https://mac.getutm.app/)を開きます。
2. UTMをダウンロードして`アプリケーション`へ入れます。
3. UTMを起動します。

期待結果:

- UTMのホーム画面が開く。

### Step 2. Windows 11のISOを入手する

1. Apple Silicon Macなら`Windows 11 ARM64`を選びます。
2. Intel Macなら`Windows 11 x64`を選びます。
3. UTM公式ガイドで案内されているCrystalFetch、またはMicrosoft公式からISOを取得します。

期待結果:

- Macの種類に合うISOファイルが1つある。
- Apple Siliconなのに`amd64/x64` ISO、Intel Macなのに`arm64` ISOを選んでいない。

### Step 3. UTMで仮想マシンを作る

1. UTMの`+`を押します。
2. `Virtualize`を選びます。
3. `Windows`を選びます。
4. Step 2のISOを指定します。
5. `Install Windows 10 or higher`を有効にします。
6. `Install drivers and SPICE tools`を有効にします。
7. 次を目安に割り当てます。

| 項目 | 推奨値 |
|---|---:|
| CPU | 4コア以上 |
| メモリ | 8GB以上。Macの搭載量が少ない場合は4GB以上 |
| ディスク | 80GB以上 |

8. Mac側に空の共有フォルダを作り、UTMの共有ディレクトリに指定します。例: `screen-capture-e2e-share`。
9. VM名を`SCR-Windows11-E2E`として保存します。

期待結果:

- VMの概要にWindows ISOと共有フォルダが表示される。

### Step 4. Windowsをインストールする

1. VMを起動します。
2. 起動時に表示されたら任意のキーを押し、ISOから起動します。
3. Windowsセットアップを進めます。
4. プロダクトキー画面では、現時点では`プロダクトキーがありません`を選びます。
5. テスト専用のローカルユーザーを作ります。例: `scr-e2e-user`。
6. 実名、実メール、会社の本番アカウントは使いません。

期待結果:

- Windowsデスクトップまで起動できる。
- 管理者用ではない通常のテストユーザーでログインしている。

### Step 5. Guest Tools、Windows Update、時刻を確認する

1. UTMのCDメニューから`Install Windows Guest Tools`を選びます。
2. Windows内でGuest Toolsをインストールします。
3. Windowsを再起動します。
4. `設定 > Windows Update`で更新を適用します。
5. `設定 > 時刻と言語 > 日付と時刻`で、時刻とタイムゾーンが正しいことを確認します。
6. エクスプローラーの`PC`または`ネットワークの場所`に、Macとの共有フォルダが見えることを確認します。

期待結果:

- 画面サイズを変更できる。
- ネットワークが利用できる。
- Macとの共有フォルダへテストファイルをコピーできる。
- Windowsの現在日時が正しい。

### Step 6. クリーン状態を退避する

1. Windowsを完全にシャットダウンします。`保存状態`ではなく`シャットダウン`を使います。
2. UTMのVMを複製できる場合は`SCR-Windows11-Clean`として複製します。
3. 複製機能が見つからない場合は、FinderでUTMのVMパッケージを別の安全な場所へコピーします。

期待結果:

- アプリ導入前へ戻せるクリーンなVMがある。

---

## Phase 2: ソースとWindows成果物を用意する

### Step 7. Windows側の作業フォルダを作る

Windows PowerShellを開き、次を実行します。

```powershell
$Work = "$HOME\Desktop\screen-capture-report-e2e"
New-Item -ItemType Directory -Path $Work -Force | Out-Null
Set-Location $Work
```

### Step 8. CI成果物をダウンロードする

推奨はGitHub Actionsの成功済み成果物です。

1. ブラウザで[Windows verification run 29594165022](https://github.com/MasahiroOkamura-MAC/screen-capture-report/actions/runs/29594165022)を開きます。
2. GitHubへログインします。
3. 画面下部の`Artifacts`から次をダウンロードします。

```text
windows-package-d04728c66491d6256127e296250f03d432b6e02e
```

4. ダウンロードしたzipを`$Work\ci-artifact`へ展開します。

GitHub CLIを使える場合は、代わりに次でも取得できます。

```powershell
gh run download 29594165022 `
  -n windows-package-d04728c66491d6256127e296250f03d432b6e02e `
  -D "$Work\ci-artifact"
```

注意:

- Actions成果物の保持期間は14日です。
- 見つからない場合は、`blushup-windows`の`Windows verification`を再実行するか、Step 11のWindowsローカルビルドを使います。

### Step 9. インストーラーのSHA-256を確認する

```powershell
$Installer = Get-ChildItem "$Work\ci-artifact" -Recurse `
  -Filter "ScreenCaptureReport-Setup-0.2.1-x64.exe" | Select-Object -First 1

if (-not $Installer) { throw "Installer not found" }

$Installer | Format-List FullName,Length
Get-FileHash $Installer.FullName -Algorithm SHA256
```

期待値:

```text
Length: 28572504 bytes
SHA256: 784A5B44FA1613274276A577A1B9C6851F5C19E522EF108ABA56FE3FCD43CAB2
```

期待結果:

- サイズとSHA-256が一致する。
- 一致しない場合は実行せず、再ダウンロードする。

### Step 10. `blushup-windows`のソースを用意する

証跡確認用CLIとSQLiteの安全なメタデータ確認に、ソース一式を使います。

Gitがある場合:

```powershell
Set-Location $Work
git clone --branch blushup-windows --single-branch `
  https://github.com/MasahiroOkamura-MAC/screen-capture-report.git repo
Set-Location "$Work\repo"
git rev-parse HEAD
```

期待するHEAD:

```text
d04728c66491d6256127e296250f03d432b6e02e
```

Gitを使わない場合は、Macの既存リポジトリを共有フォルダ経由でコピーするか、GitHubからブランチのSource ZIPを取得します。

### Step 11. Python証跡ツールを準備する

1. Windows用Python 3.12 x64をインストールします。
   - Apple Silicon上のWindows 11 ARMでも、本アプリと同じx64経路を検証するためx64版を使います。
2. PowerShellで次を実行します。

```powershell
Set-Location "$Work\repo"
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --require-hashes -r requirements-lock.txt
.\.venv\Scripts\python.exe -m ruff check src tests
.\.venv\Scripts\python.exe -m mypy src
.\.venv\Scripts\python.exe -m pytest
```

期待結果:

- ruff: `All checks passed!`
- mypy: `Success: no issues found in 17 source files`
- pytest: `59 passed`

ローカルWindowsビルドも確認する場合:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\build_windows.ps1 2>&1 | Tee-Object "$Work\build-windows-utm.log"
```

注意:

- Apple Silicon上のx64エミュレーションではビルドに時間がかかります。
- Inno Setupがなければ、`dist\ScreenCaptureReport-windows-x64.zip`が生成されます。これは後のzipフォールバック試験に使えます。

---

## Phase 3: 証跡フォルダと確認コマンドを準備する

### Step 12. 証跡フォルダを作る

```powershell
$Date = Get-Date -Format "yyyy-MM-dd"
$Evidence = "C:\e2e-evidence\$Date"
$Repo = "$Work\repo"
$Python = "$Repo\.venv\Scripts\python.exe"
New-Item -ItemType Directory -Path $Evidence -Force | Out-Null
```

次の内容で`$Evidence\TEST-RESULTS.md`を作ります。

```markdown
# Windows UTM E2E Results

- Date:
- Mac architecture:
- UTM version:
- Windows edition/version/build:
- Windows architecture:
- App commit: d04728c66491d6256127e296250f03d432b6e02e
- Tester:

| E2E ID | Result | Evidence file | Notes |
|---:|---|---|---|
| 1 | NOT RUN | | |
| 2 | NOT RUN | | |
| 3 | NOT RUN | | |
| 4 | NOT RUN | | |
| 5 | NOT RUN | | |
| 6 | NOT RUN | | |
| 7 | NOT RUN | | |
| 8 | NOT RUN | | |
| 9 | NOT RUN | | |
| 10 | NOT RUN | | |
| 11 | NOT RUN | | |
| 12 | NOT RUN | | |
| 13 | NOT RUN | | |
| 14 | NOT RUN | | |
| 15 | NOT RUN | | |
| 16 | NOT RUN | | |
| 17 | NOT RUN | | |
| 18 | NOT RUN | | |
```

### Step 13. Windows情報を保存する

```powershell
Get-ComputerInfo | Select-Object `
  WindowsProductName,WindowsVersion,OsBuildNumber,OsArchitecture | `
  Format-List | Out-File "$Evidence\windows-info.txt"

Get-FileHash $Installer.FullName -Algorithm SHA256 | `
  Format-List | Out-File "$Evidence\installer-sha256.txt"
```

### Step 14. 安全なDBメタデータを書き出す関数を登録する

次をPowerShellへそのまま貼り付けます。この関数は暗号化された画面内容、ウィンドウタイトル、メールアドレス、レポート本文を読みません。

```powershell
function Export-ScrState {
    param([Parameter(Mandatory = $true)][string]$Name)

    $env:SCR_DB = "$env:LOCALAPPDATA\ScreenCaptureReport\screen-capture-report.sqlite3"
    $Code = @'
import json
import os
import sqlite3
from pathlib import Path

db_path = Path(os.environ["SCR_DB"])
if not db_path.exists():
    print(json.dumps({"database_exists": False}, indent=2))
    raise SystemExit(0)

queries = {
    "captures": """
        SELECT id, captured_at, status, rule_id, file_path, error_code,
               retry_count, next_retry_at, analyzed_at
        FROM captures ORDER BY captured_at DESC LIMIT 100
    """,
    "control_events": """
        SELECT occurred_at, state FROM control_events
        ORDER BY occurred_at DESC LIMIT 50
    """,
    "work_logs": """
        SELECT id, start_at, end_at, category, confidence, estimated_minutes,
               capture_ids_json
        FROM work_logs ORDER BY start_at DESC LIMIT 100
    """,
    "reports": """
        SELECT id, kind, period_start, period_end, audience, artifact_path,
               finalized, created_at
        FROM reports ORDER BY created_at DESC LIMIT 50
    """,
    "send_log": """
        SELECT id, report_id, audience, status, error_code, retry_count,
               next_retry_at, sent_at, created_at
        FROM send_log ORDER BY created_at DESC LIMIT 50
    """,
    "retention_audit": """
        SELECT occurred_at, data_type, item_id, reason
        FROM retention_audit ORDER BY occurred_at DESC LIMIT 100
    """,
    "report_jobs": """
        SELECT kind, period_start, status, error_code, retry_count,
               next_retry_at, updated_at
        FROM report_jobs ORDER BY updated_at DESC LIMIT 50
    """,
    "cost_ledger": """
        SELECT occurred_at, operation, model, input_tokens, output_tokens,
               cost_jpy, is_estimate
        FROM cost_ledger ORDER BY occurred_at DESC LIMIT 100
    """,
}

connection = sqlite3.connect(db_path)
connection.row_factory = sqlite3.Row
try:
    output = {"database_exists": True}
    for name, sql in queries.items():
        output[name] = [dict(row) for row in connection.execute(sql)]
    print(json.dumps(output, ensure_ascii=False, indent=2))
finally:
    connection.close()
'@

    $Code | & $Python - | Out-File "$Evidence\$Name.json" -Encoding utf8
}
```

使用例:

```powershell
Export-ScrState "01-before-consent"
```

### Step 15. 操作ログを取る

APIキーやSMTPパスワードの入力が終わるまで、PowerShellのTranscriptを開始しないでください。このStepではコマンドだけ確認し、実際の開始はStep 18の秘密入力が終わった後に行います。

```powershell
Start-Transcript -Path "$Evidence\powershell-transcript.txt" -Append
```

すべて終わったら次で停止します。

```powershell
Stop-Transcript
```

---

## Phase 4: インストールと同意前の非取得を確認する

### Step 16. per-userインストールを行う

`0.2.0`を既にインストール済みで、プロセスは動くのにトレイアイコンが出ない場合は、先に次を行います。

1. `Ctrl + Shift + Esc`でタスクマネージャーを開きます。
2. `詳細`から`ScreenCaptureReport.exe`を選び、`タスクの終了`を押します。
3. Step 9でハッシュ確認した`ScreenCaptureReport-Setup-0.2.1-x64.exe`を起動し、同じ場所へ上書きインストールします。
4. `%LOCALAPPDATA%\ScreenCaptureReport`の既存設定・同意・資格情報は保持されるため、通常は初期設定の再入力は不要です。

`0.2.0`ではpystrayのカスタム起動処理が通知アイコンを可視化しておらず、プロセスだけが動く不具合がありました。トレイ検証には必ず`0.2.1`以降を使ってください。

1. Step 9でハッシュ確認したインストーラーを起動します。
2. UACの管理者パスワードを要求されないことを確認します。
3. `Windowsログイン時に起動する`は最初はオフのままにします。
4. インストールを完了します。
5. スタートメニューに`Screen Capture Report`があることを確認します。

SmartScreenが表示された場合:

1. SHA-256がStep 9と完全一致していることを再確認します。
2. 一致している場合だけ、`詳細情報 > 実行`で進めます。
3. 一致していない場合は中止します。

期待結果:

- `%LOCALAPPDATA%\Programs\ScreenCaptureReport`へインストールされる。
- 管理者権限を要求しない。
- 自動起動は明示的に選ばない限りオフ。

### Step 17. 同意前に取得されないことを確認する

1. `Screen Capture Report - 初期設定`画面を開いたままにします。
2. 同意チェックを入れず、65秒以上待ちます。
3. 別のPowerShellで次を実行します。

```powershell
$Data = "$env:LOCALAPPDATA\ScreenCaptureReport"
Get-ChildItem "$Data\captures" -Recurse -File -ErrorAction SilentlyContinue
Export-ScrState "01-before-consent"
```

4. 初期設定画面のスクリーンショットを、秘密入力前の状態で`$Evidence\01-before-consent.png`へ保存します。

期待結果:

- `captures`配下に画像ファイルがない。
- `01-before-consent.json`の`captures`に`captured`行がない。
- 初期設定を閉じた場合、アプリは取得を始めず終了する。

### Step 18. 架空データでオンボーディングする

実Geminiキーがまだない場合は、意図的なダミー値を使います。

| 項目 | 入力例 |
|---|---|
| Gemini APIキー | `e2e-invalid-key`。実解析を行う段階ではテスト用実キーに変更する |
| 従業員識別子 | `e2e-user-001` |
| 部署 | `E2E Test` |
| 訂正・削除・事故連絡先 | `privacy-test@example.invalid` |
| 本人メール | 最初は空欄 |
| 経営レポートメール | 最初は空欄 |
| SMTPユーザー | 最初は空欄 |
| SMTPパスワード | 最初は空欄 |
| 勤務開始 | 現在時刻より前 |
| 勤務終了 | 現在時刻より1時間以上後 |
| 稼働曜日 | 当日の番号を含める。月=0、火=1、水=2、木=3、金=4、土=5、日=6 |

1. 同意チェックを入れます。
2. `同意して開始`を押します。
3. 通知領域の`^`を開き、Screen Capture Reportのアイコンを探します。

期待結果:

- トレイアイコンが表示される。
- 取得中ならアイコン右下が緑。
- 初期設定画面が閉じる。

### Step 19. 秘密情報が平文設定へ入っていないことを確認する

```powershell
$Data = "$env:LOCALAPPDATA\ScreenCaptureReport"
Get-ChildItem $Data -Force
Select-String -Path "$Data\config.json" `
  -Pattern "e2e-invalid-key","api_key","smtp_password" -SimpleMatch
```

1. `コントロールパネル > 資格情報マネージャー > Windows資格情報`も開きます。
2. `ScreenCaptureReport`に関係する汎用資格情報があるか確認します。
3. 資格情報マネージャーが使えない場合は、`secrets.dpapi.json`がDPAPIフォールバックとして存在することがあります。その内容を復号・公開しません。

期待結果:

- `config.json`に入力したAPIキーやSMTPパスワードがない。
- `data-key.dpapi`が存在する。
- 秘密情報はWindows資格情報、またはDPAPI保護されたフォールバックに保存される。

---

## Phase 5: Gemini実キーなしでできる基本E2E

### Step 20. トレイの一時停止・再開を確認する

1. アプリ起動後、Windows右下の通知領域または`^`内にアイコンが表示されることを確認します。
2. アイコンへマウスを合わせ、`Screen Capture Report - 取得中`と表示されることを確認します。
3. トレイアイコンを右クリックします。
4. `一時停止`を押します。
5. アイコン右下がグレーになることを確認します。
6. 65秒待ちます。
7. `Export-ScrState "02-paused"`を実行します。
8. `取得を開始`を押します。
9. アイコン右下が緑になることを確認します。
10. `Export-ScrState "03-resumed"`を実行します。
11. タスクマネージャーからWindows Explorerを再起動し、アイコンが通知領域へ再表示されることを確認します。
12. トレイの`終了`を押し、アイコンが消えることを確認します。その後スタートメニューから再起動します。

期待結果:

- `control_events`に`paused`と`active`が記録される。
- 一時停止中の自動周期では`paused`となり、画像ファイルが増えない。

注意: `今すぐ取得`は利用者が明示的に押す手動操作です。一時停止の自動取得テスト中は押さないでください。

### Step 21. 60秒周期を確認する

1. `設定`で取得モードを`active_window`にします。
2. 勤務時間と稼働曜日が現在を含むことを確認します。
3. メモ帳で架空の文章だけを表示します。例: `E2E synthetic document 001`。
4. メモ帳を前面にしたまま6分待ちます。
5. 次を実行します。

```powershell
Export-ScrState "04-cadence"

$env:SCR_DB = "$env:LOCALAPPDATA\ScreenCaptureReport\screen-capture-report.sqlite3"
@'
import os
import sqlite3
from datetime import datetime

connection = sqlite3.connect(os.environ["SCR_DB"])
rows = connection.execute(
    """SELECT captured_at, status FROM captures
       WHERE status IN ('captured', 'analysis_failed', 'analyzed')
       ORDER BY captured_at DESC LIMIT 10"""
).fetchall()[::-1]
for previous, current in zip(rows, rows[1:]):
    delta = datetime.fromisoformat(current[0]) - datetime.fromisoformat(previous[0])
    print(previous[0], "->", current[0], "delta_seconds=", delta.total_seconds())
connection.close()
'@ | & $Python - | Out-File "$Evidence\04-cadence-deltas.txt" -Encoding utf8
```

期待結果:

- 少なくとも5回の自動取得記録がある。
- 連続する対象時刻の差が原則55〜65秒。
- Apple Silicon上で大きく外れる場合は、値を`FAIL`として残し、ネイティブx64 Windowsで再測定する。

### Step 22. 勤務時間外と不正な日跨ぎ設定を確認する

1. 設定の稼働曜日から今日を外します。
2. 65秒待ちます。
3. `Export-ScrState "05-outside-day"`を実行します。
4. 勤務開始を`20:00`、勤務終了を`08:00`として保存を試します。
5. 保存エラーになることを確認します。
6. 元の正常な時間と曜日へ戻します。

期待結果:

- 非稼働曜日は`outside_hours`になり、画像を取得しない。
- 日跨ぎ勤務設定は保存されない。

### Step 23. 除外タイトルを確認する

1. `password-e2e.txt`という架空ファイルをメモ帳で開きます。
2. そのウィンドウを前面にします。
3. トレイから`今すぐ取得`を押します。
4. `Export-ScrState "06-excluded-title"`を実行します。

期待結果:

- 最新記録のstatusが`excluded`。
- `rule_id`は`title_keyword:<番号>`で、実際のタイトル文字列を含まない。
- 新しい暗号化画像ファイルが作られない。

### Step 24. 除外プロセスと検査不能プロセスを確認する

1. 設定の`除外プロセス`へ、テスト用に`notepad.exe`を追加します。
2. 通常のメモ帳を前面にして`今すぐ取得`を押します。
3. `Export-ScrState "07-excluded-process"`を実行します。
4. `notepad.exe`を除外一覧から戻します。
5. 可能なら、管理者として起動したテスト用PowerShellなど、通常ユーザーからプロセス情報を取得できないウィンドウを前面にして試します。

期待結果:

- 除外プロセスでは`excluded`かつ`process:<番号>`のみが残る。
- プロセス検査が拒否された場合は`process:inspection_failed`でfail-closedになる。
- OS側がプロセス名を公開して再現できない場合は、その項目だけ`BLOCKED`と記録する。

### Step 25. 全画面モードと複数画面fail-closedを確認する

1. Windowsの`設定 > システム > ディスプレイ`を開きます。
2. Windowsから2台目のディスプレイが見えている場合だけ、完全な複数画面試験を行います。
3. 設定で取得モードを`all_screens`へ変更します。
4. 画面1には許可された架空ウィンドウを置きます。
5. 画面2には`password-e2e.txt`を開いたメモ帳を置きます。
6. 画面1の許可ウィンドウを前面にして`今すぐ取得`を押します。
7. `Export-ScrState "08-all-screens-excluded"`を実行します。

期待結果:

- 画面2に除外ウィンドウがあるため、画面全体を取得しない。
- statusは`excluded`、rule_idは`all_screens:title_keyword:<番号>`。

UTMでディスプレイが1台しか見えない場合:

- 同一画面に除外ウィンドウを表示して全画面fail-closed自体は確認する。
- 複数画面の部分は`BLOCKED: UTM display limitation`と記録し、物理Windowsまたは複数画面対応環境で後日実施する。

### Step 26. 暗号化保存を確認する

実キーがない場合は解析が失敗するため、暗号化された一時画像を確認しやすい状態です。

```powershell
$CaptureFile = Get-ChildItem "$env:LOCALAPPDATA\ScreenCaptureReport\captures" `
  -Recurse -Filter "*.png.enc" | Select-Object -First 1

if (-not $CaptureFile) { throw "Encrypted capture not found" }

$Bytes = [System.IO.File]::ReadAllBytes($CaptureFile.FullName)
$Header = [BitConverter]::ToString($Bytes[0..7])
$CaptureFile | Format-List FullName,Length
"EncryptedHeader=$Header"
"PNGHeader=89-50-4E-47-0D-0A-1A-0A"
```

期待結果:

- 拡張子は`.png.enc`。
- 先頭8バイトがPNGシグネチャと一致しない。
- 通常の画像ビューアーでPNGとして開けない。

### Step 27. 5分離席を確認する

1. 設定の`離席判定（秒）`が`300`であることを確認します。
2. 取得中の緑状態にします。
3. Mac側で6分のタイマーを開始します。
4. その間、Windows VMのキーボードとマウスを一切操作しません。
5. 6分後にVMへ戻り、`Export-ScrState "09-idle"`を実行します。

期待結果:

- statusに`idle`がある。
- idle周期に画像payloadがない。
- idleは成功率の対象外になる。

### Step 28. Windowsロック中の非取得を確認する

1. 取得中の緑状態にします。
2. Windowsゲスト内で`Win + L`を送ります。
3. Macキーボードから送れない場合は、Windowsの`スタート > ユーザー > ロック`を使います。
4. 70秒以上ロック状態を維持します。
5. ロック画面そのものの証跡は、Mac側のスクリーンショットで残します。
6. Windowsへ再ログインします。
7. `Export-ScrState "10-locked"`を実行します。

期待結果:

- statusに`locked`がある。
- ロック中の画像payloadがない。
- lockedは成功率の対象外になる。

### Step 29. 失敗キューと再起動保持を確認する

ダミーGeminiキーでは成功復旧までは確認できませんが、失敗状態が再起動後も残ることは確認できます。

1. トレイから`今すぐ取得`を押します。
2. `今すぐ解析`を押します。
3. 30秒待ちます。
4. `Export-ScrState "11-analysis-failed-before-restart"`を実行します。
5. トレイから`終了`します。
6. スタートメニューからアプリを再起動します。
7. `Export-ScrState "12-analysis-failed-after-restart"`を実行します。

期待結果:

- `analysis_failed`、`retry_count`、`next_retry_at`が記録される。
- アプリ再起動後も対象行と暗号化payloadが残る。
- 実際に`analyzed`へ復旧する確認はPhase 6で行う。

### Step 30. 一時停止状態、再起動、自動起動、二重起動を確認する

1. トレイから`一時停止`します。
2. Windowsを再起動します。
3. スタートメニューからアプリを起動します。
4. トレイがグレーのままであることを確認します。
5. `取得を開始`を押します。
6. もう一度スタートメニューから同じアプリを起動します。
7. 次を実行します。

```powershell
Get-Process ScreenCaptureReport | Select-Object Id,ProcessName,StartTime
```

8. 設定で`Windowsログイン時に起動`をオンにします。
9. Windowsを再起動します。

期待結果:

- 一時停止状態が再起動後も維持される。
- 二重起動を試しても常駐プロセスは1つだけ。
- 自動起動を明示的にオンにした後は、ログイン後にトレイへ復帰する。

### Step 31. 今日の画像削除を確認する

1. 暗号化画像が1件以上あることを確認します。
2. トレイの`今日の画像を削除`を押します。
3. 30秒待ちます。
4. `Export-ScrState "13-delete-today"`を実行します。

期待結果:

- 今日の画像payloadが削除される。
- captureメタデータの`file_path`が空になる。
- `retention_audit`に`employee_delete_today`が記録される。

### Step 32. ローカル日報とアクセス境界の基本動作を確認する

1. トレイの`日報を生成`を押します。
2. 30秒待ちます。
3. `最新の日報を開く`を押します。
4. 日報ウィンドウが開くことを確認します。
5. `週次レポートを生成`を押します。
6. `Export-ScrState "14-local-reports"`を実行します。

期待結果:

- 日報はemployee audienceで保存される。
- 週次レポートはmanagement audienceで保存される。
- トレイの`最新の日報を開く`からmanagement週次レポートは表示されない。

重要:

- トレイの手動`日報を生成`と`週次レポートを生成`はローカル確認用で、メールを送信しません。
- ダミーGeminiキーでは実解析済みの内容品質、改善提案、精度を合格にできません。

---

## Phase 6: テスト用Geminiキーで行うライブE2E

このPhaseは、専用の非本番Gemini APIキーを用意してから実施します。実従業員の画面は使いません。

### Step 33. Geminiキーをテスト用実キーへ変更する

1. トレイの`設定`を開きます。
2. `新しいGemini APIキー`へテスト専用キーを入力します。
3. `保存`を押します。
4. `config.json`や証跡ファイルへキーが出ていないことを確認します。

キー入力中はスクリーンショットとTranscriptを停止してください。

### Step 34. 実解析と解析後削除を確認する

1. 架空の業務画面だけを前面にします。
2. `今すぐ取得`を5回行い、各回の間に数秒待ちます。
3. `今すぐ解析`を押します。
4. 最大60秒待ちます。
5. `Export-ScrState "15-live-analysis"`を実行します。

期待結果:

- 対象captureが`analyzed`になる。
- `work_logs`にcategory、confidence、estimated_minutes、capture IDが残る。
- 解析成功済みcaptureの`file_path`が空になる。
- `retention_audit`に`analysis_success_immediate_delete`が残る。
- `cost_ledger`にusage metadataが記録される。

### Step 35. オフライン失敗からの再送を確認する

1. Windowsの`設定 > ネットワークとインターネット > ネットワークの詳細設定`を開きます。
2. UTMのEthernetアダプターを無効にします。
3. 架空画面で`今すぐ取得`、続けて`今すぐ解析`を押します。
4. `Export-ScrState "16-offline-failed"`を実行します。
5. アプリを終了し、再起動します。
6. Ethernetアダプターを有効にします。
7. ネット接続復旧後に`今すぐ解析`を押します。
8. 最大60秒待ちます。
9. `Export-ScrState "17-online-recovered"`を実行します。

期待結果:

- オフライン中は失敗と`next_retry_at`が永続化される。
- 再起動でキューが消えない。
- 復旧後は同じcaptureが`analyzed`になり、payloadが削除される。

### Step 36. 日報と週次レポートの内容を確認する

1. `日報を生成`を押します。
2. `最新の日報を開く`で次を確認します。
   - 対象日
   - カテゴリ別時間
   - 活動要約
   - 未分類時間
   - 架空の従業員IDと部署
3. `週次レポートを生成`を押します。
4. `Export-ScrState "18-live-reports"`を実行します。

週次レポートの期待結果:

- `改善方法`
- `AI化候補`
- `期待生産性向上`
- 根拠ログID
- 前提条件

含めてはいけないもの:

- スクリーンショット
- 生のウィンドウタイトル
- 個人ランキング
- 査定、懲戒、performance score
- 分単位の個人行動列

現在週の手動生成は画面・内容・アクセス境界の確認です。`前週の自動回収`と`report_jobs.next_retry_at`の実時間確認は、前週データがあるテスト環境が必要です。前週データがない場合は`BLOCKED`とし、既存自動テストを補助証跡にします。Windowsの日付を無理に変更して証明しないでください。

アクセス境界を本文を出力せずに確認するには、アプリを終了してから次を実行します。

```powershell
Set-Location $Repo
@'
import json

from src.config import get_data_dir
from src.security import EncryptionService
from src.storage import (
    Database,
    EMPLOYEE_REPORT_ACCESS,
    MANAGEMENT_REPORT_ACCESS,
)

data_dir = get_data_dir()
encryption = EncryptionService.from_key_file(data_dir / "data-key.dpapi")
database = Database(data_dir / "screen-capture-report.sqlite3", encryption)
try:
    employee = database.list_reports(access=EMPLOYEE_REPORT_ACCESS)
    management = database.list_reports(access=MANAGEMENT_REPORT_ACCESS)
    forbidden = [
        "<img", ".png", "window title", "ウィンドウタイトル",
        "ランキング", "employee ranking", "performance score", "査定", "懲戒",
    ]
    result = {
        "employee_reports": [
            {"id": item["id"], "kind": item["kind"], "audience": item["audience"]}
            for item in employee
        ],
        "management_reports": [
            {"id": item["id"], "kind": item["kind"], "audience": item["audience"]}
            for item in management
        ],
        "employee_can_read_management": any(
            database.get_report(item["id"], access=EMPLOYEE_REPORT_ACCESS) is not None
            for item in management
        ),
        "management_can_read_employee": any(
            database.get_report(item["id"], access=MANAGEMENT_REPORT_ACCESS) is not None
            for item in employee
        ),
        "management_content_checks": [],
    }
    for item in management:
        body = (item.get("payload") or "").casefold()
        result["management_content_checks"].append({
            "id": item["id"],
            "has_three_sections": all(
                heading in body for heading in ("改善方法", "ai化候補", "期待生産性向上")
            ),
            "forbidden_hits": [value for value in forbidden if value in body],
        })
    print(json.dumps(result, ensure_ascii=False, indent=2))
finally:
    database.close()
'@ | & $Python - | Out-File "$Evidence\18-report-boundaries.json" -Encoding utf8
```

期待結果:

- `employee_can_read_management`は`false`。
- `management_can_read_employee`は`false`。
- management週次レポートの`has_three_sections`は`true`。
- `forbidden_hits`は空配列。
- レポート本文そのものは証跡へ出力されない。

前週データがある場合のGemini障害・backoff確認:

1. 前週の`work_logs`が存在することを`Export-ScrState`で確認します。
2. テスト用Geminiキーを一時的にダミー値へ変えるか、ネットワークを切断します。
3. アプリを再起動し、20秒待って`Export-ScrState "18a-weekly-failed"`を実行します。
4. `report_jobs`のprevious-week行が`failed`で、`retry_count`と未来の`next_retry_at`を持つことを確認します。
5. `next_retry_at`より前にもう20秒待ち、`Export-ScrState "18b-weekly-before-retry"`を実行します。
6. `retry_count`が15秒ごとに増えていないことを確認します。
7. 正しいテストキーまたはネットワークを復旧し、`next_retry_at`を過ぎてから最大2分待ちます。
8. `Export-ScrState "18c-weekly-recovered"`を実行し、jobが`succeeded`になることを確認します。

---

## Phase 7: SMTP実送信を確認する

このPhaseは、テスト専用メールボックス、SMTPユーザー、アプリパスワードを用意した場合だけ実施します。

### Step 37. テストメール設定を入れる

1. `設定`を開きます。
2. `本人メール`へテスト専用の受信先を入れます。
3. 必要なら`経営レポートメール`へ別のテスト専用受信先を入れます。
4. `SMTPユーザー`と`新しいSMTPパスワード`を入力します。
5. 保存します。
6. 入力中のスクリーンショット、Transcript、画面共有は行いません。

### Step 38. 1回失敗させてから自動復旧を確認する

1. 勤務終了直前に架空画面を1回取得・解析し、`work_logs`にその記録があることを確認します。
2. 最初は意図的に誤ったテスト用SMTPパスワードを保存します。
3. 今日のcaptureがすべて解析済みであることを確認します。
4. 勤務終了時刻まで待ちます。
5. 既定設定では、勤務終了後さらに約5分30秒（60秒 × 5件 + 30秒）のflush待ちがあります。
6. `Export-ScrState "19-smtp-failed"`を実行します。
7. `send_log`が`failed`で`next_retry_at`を持つことを確認します。
8. 設定で正しいテスト用SMTPパスワードへ直します。
9. `next_retry_at`を過ぎてから最大2分待ちます。
10. `Export-ScrState "20-smtp-recovered"`を実行します。
11. テスト用受信箱を確認します。
12. `最新の日報を開く`で、勤務終了直前の架空ログが日報へ含まれることを確認します。

期待結果:

- 最初の送信失敗が監査される。
- アプリを再起動しても失敗送信が失われない。
- 設定修正後に`sent`となる。
- テスト用受信箱へ日報が1通届く。

注意:

- 手動の`日報を生成`ボタンはメール送信を行いません。メールはfinalizedされた自動日報で確認します。
- 自己署名SMTP証明書の実拒否試験には、STARTTLSと自己署名証明書を有効にした専用のローカルSMTP試験サーバーが別途必要です。利用できる場合は、クリーンVMでアプリを終了し、`config.json`の`smtp_server`と`smtp_port`をその試験サーバーへ向け、再起動後に自動日報送信を発生させます。`send_log.error_code`が証明書検証エラーになり、送信済みにならないことを確認します。用意できない場合は`BLOCKED`とし、`tests/test_notifier.py`のTLS検証を補助証跡にします。補助テストだけでライブ試験を`PASS`にしません。

---

## Phase 8: 精度・取得成功率・原価を確認する

### Step 39. 日次メトリクスを出す

```powershell
Set-Location $Repo
$Today = Get-Date -Format "yyyy-MM-dd"
.\.venv\Scripts\python.exe -m src.cli metrics $Today | `
  Tee-Object "$Evidence\21-metrics.json"
```

期待値:

- 取得成功率: 95%以上
- duplicate_attempts: 0
- missing_intervals: 0が理想。欠落があれば理由を記録する
- 全API原価: 100円/人日以下

原価設定について:

- `config.json`の`token_input_jpy_per_million`と`token_output_jpy_per_million`が0のままだと、原価は`unmeasured`です。
- 設定値を変更するときは、トレイからアプリを終了し、`config.json`をバックアップしてから2項目だけを編集し、その後アプリを再起動します。
- 現在の承認済み契約単価を日付・出典付きで確認してから設定します。
- 単価が未設定、usage metadataがない、実キーがない場合は`PASS`にしません。

欠落と重複を検出できることも、意図的な異常試験で確認します。この試験を行った日は最終成功率の合格測定には使いません。

既知のプロセス停止ギャップ:

1. 取得中の緑状態にします。
2. タスクマネージャーから`ScreenCaptureReport.exe`を`タスクの終了`で強制終了します。トレイの正常終了は使いません。
3. 75秒以上待ちます。
4. アプリを再起動します。
5. `metrics`を再実行し、`missing_intervals`が1以上に増えることを確認します。

既知の重複試行:

1. 同じ60秒枠の中で、`今すぐ取得`を2回続けて押します。
2. `metrics`を再実行します。
3. `duplicate_attempts`が1以上となり、`passed`が`false`になることを確認します。

異常検出の確認後、最終合格値はクリーンVMまたは別のテスト日で取り直します。

### Step 40. 人手ラベル精度を測る

```powershell
.\.venv\Scripts\python.exe -m src.cli export-labels `
  $Today "$Evidence\labels-$Today.csv"
```

1. `labels-$Today.csv`を開きます。
2. `expected_category`列へ、人が正解と判断したカテゴリIDを入力します。
3. 次を実行します。

```powershell
.\.venv\Scripts\python.exe -m src.cli accuracy `
  "$Evidence\labels-$Today.csv" | Tee-Object "$Evidence\22-accuracy.json"
```

期待値:

- `measured: true`
- `invalid_rows: []`
- 一致率80%以上

ラベル0件、空欄、未計測は合格ではありません。

---

## Phase 9: アンインストールとzipフォールバックを確認する

### Step 41. データを残すアンインストールを確認する

1. `設定 > アプリ > インストールされているアプリ`からScreen Capture Reportをアンインストールします。
2. データ削除の質問では`いいえ`を選びます。
3. 次を確認します。

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\ScreenCaptureReport"
Test-Path "$env:LOCALAPPDATA\ScreenCaptureReport"
```

期待結果:

- アプリのインストール先は`False`。
- ユーザーデータは`True`。
- スタートメニューと自動起動登録は削除される。
- 保存済み資格情報はアンインストール準備処理で削除される。

### Step 42. データも削除するアンインストールを確認する

1. アプリを再インストールします。
2. 再度アンインストールします。
3. データ削除の質問では`はい`を選びます。
4. 次を確認します。

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\ScreenCaptureReport"
Test-Path "$env:LOCALAPPDATA\ScreenCaptureReport"
```

期待結果:

- 両方とも`False`。
- 資格情報マネージャーにScreenCaptureReportの秘密情報が残っていない。

### Step 43. zipフォールバックを別ユーザーで確認する

1. Inno SetupがPATHにないWindows環境で、Step 11の`build_windows.ps1`を実行します。
2. `dist\ScreenCaptureReport-windows-x64.zip`が生成されたことを確認します。
3. Windowsに新しい標準ローカルユーザー`SCRZipTest`を作るか、クリーンVMへ戻します。
4. zipだけを新しいユーザーへコピーし、展開します。
5. 展開先のPowerShellで次を実行します。

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
```

自動起動も明示的に試す場合だけ:

```powershell
.\scripts\install.ps1 -EnableAutostart
```

期待結果:

- zipだけでインストールできる。
- 管理者権限を要求しない。
- スタートメニューから起動できる。
- `-EnableAutostart`なしでは自動起動を登録しない。

---

## Phase 10: 証跡をまとめる

### Step 44. ログをコピーして機微情報を確認する

```powershell
$Data = "$env:LOCALAPPDATA\ScreenCaptureReport"
Copy-Item "$Data\app.log" "$Evidence\app.log" -ErrorAction SilentlyContinue
Copy-Item "$Data\config.json" "$Evidence\config.json" -ErrorAction SilentlyContinue
```

確認するもの:

- APIキー、SMTPパスワードがない
- 実メールアドレスや実個人情報がない
- 画面内容やレポート本文がない
- エラーは例外クラス、状態、件数などに限定されている

### Step 45. 証跡をMacへ退避する

1. `Stop-Transcript`を実行します。
2. `TEST-RESULTS.md`の18項目を`PASS / FAIL / BLOCKED / NOT RUN`へ更新します。
3. 証跡フォルダをzipにします。

```powershell
$Archive = "C:\e2e-evidence\ScreenCaptureReport-E2E-$Date.zip"
Compress-Archive -Path "$Evidence\*" -DestinationPath $Archive -Force
Get-FileHash $Archive -Algorithm SHA256 | `
  Format-List | Out-File "$Archive.sha256.txt"
```

4. zipと隣にできた`.sha256.txt`をUTM共有フォルダ経由でMacへコピーします。
5. コピー後、Mac側でもファイルが開けることを確認します。

コミットしてよい証跡:

- Windowsのバージョン情報
- SHA-256
- 秘密情報を含まないテスト結果表
- レダクション済みログ
- 安全なDBメタデータJSON

コミットしてはいけない証跡:

- APIキー、SMTPパスワード
- 資格情報マネージャーの秘密値
- 実個人データ入りスクリーンショット
- 復号された日報・週次レポート本文
- ラベルCSVに実個人情報が含まれる場合の原本

---

## E2Eチェックリスト18項目との対応

| E2E ID | 主な確認箇所 | キーなしで完了可能か |
|---:|---|---:|
| 1 | Step 8〜13: ビルド、テスト、成果物、SHA-256 | はい |
| 2 | Step 16: per-userインストール、自動起動opt-in | はい |
| 3 | Step 17: 同意前非取得 | はい |
| 4 | Step 18〜19、33: オンボーディング、資格情報保護 | 基本は可。実解析は実キー必要 |
| 5 | Step 20: 緑/グレー、停止・再開 | はい |
| 6 | Step 21〜22: 60秒周期、非稼働日、日跨ぎ拒否 | はい |
| 7 | Step 25〜26: active/all screens、複数画面、暗号化 | 複数画面はUTM構成次第 |
| 8 | Step 23〜24: 除外タイトル、プロセス、検査不能 | 検査不能はOS次第 |
| 9 | Step 27〜28: 5分離席、Windowsロック | はい |
| 10 | Step 29、35: オフライン、永続キュー、復旧 | 成功復旧は実Geminiキー必要 |
| 11 | Step 31、34: 解析後削除、保持監査 | 解析後削除は実Geminiキー必要 |
| 12 | Step 36〜38: 日報、SMTP失敗・復旧、TLS | 実SMTPが必要 |
| 13 | Step 36: 週次3節、境界、再試行backoff | 実Geminiと前週データが必要 |
| 14 | Step 30: 停止保持、再起動、mutex、自動起動 | はい |
| 15 | Step 41〜42: データ保持/削除アンインストール | はい |
| 16 | Step 32、36: employee/managementアクセス境界 | 内容確認は実Gemini推奨 |
| 17 | Step 39〜40: 成功率、重複、精度、原価 | 実Gemini、ラベル、単価が必要 |
| 18 | Step 43: zipフォールバック | はい |

---

## トラブルシューティング

### Windows 11のインストール中に黒画面になる

UTM Guest ToolsのISOを一度取り外して再起動し、Windowsセットアップ完了後に再度Guest Toolsを入れます。UTM公式ガイドにもWindows 11 24H2の表示ドライバーに関する既知事項があります。

### Apple Siliconでアプリが起動しない

1. WindowsがWindows 11 ARM64であることを確認します。
2. Windows Updateを完了します。
3. Windows 10 ARMではなくWindows 11を使います。
4. インストーラーのSHA-256を再確認します。
5. `%LOCALAPPDATA%\ScreenCaptureReport\app.log`と`startup-failure.txt`を確認します。

### トレイアイコンが見えない

1. 通知領域の`^`を開きます。
2. タスクマネージャーで`ScreenCaptureReport.exe`が1件あるか確認します。
3. 二重起動してもmutexにより2件目は常駐しません。
4. `設定 > アプリ > インストールされているアプリ`でバージョンが`0.2.1`以降か確認します。
5. `0.2.0`なら、プロセスを終了して`ScreenCaptureReport-Setup-0.2.1-x64.exe`を上書きインストールします。

### 画像が取得されない

次を順番に確認します。

1. トレイが緑か。
2. 今日が稼働曜日に含まれるか。
3. 現在時刻が勤務時間内か。
4. VMがロック中、5分以上離席中ではないか。
5. 前面タイトルやプロセスが除外対象ではないか。
6. `Export-ScrState`で`paused / outside_hours / locked / idle / excluded / capture_failed`のどれかを確認する。

### API解析がすべて失敗する

- `e2e-invalid-key`を使っている間は正常な期待結果です。
- ライブ解析時はテスト専用Geminiキー、ネット接続、モデル利用権限を確認します。
- 本番キーや他人のキーへ勝手に切り替えません。

### DPAPIエラーになる

DPAPI鍵はWindowsユーザーへ結び付いています。別ユーザーへ`%LOCALAPPDATA%\ScreenCaptureReport`を丸ごとコピーしないでください。テストデータだけであれば、証跡を退避した後にアンインストールでデータも削除し、同じWindowsユーザーで再オンボーディングします。

### Actions成果物が期限切れ

- GitHub Actionsの`Windows verification`を`blushup-windows`で再実行する。
- またはWindows VM内で`build_windows.ps1`を実行する。
- ハッシュを確認できない古いインストーラーを使わない。

### UTMで複数画面を再現できない

その項目だけ`BLOCKED`として、単一画面で全画面fail-closedを確認します。複数画面の完全合格は、物理Windowsまたは複数ディスプレイを公開できる別環境で行います。

---

## 完了条件

次をすべて満たしたときに、このE2Eを完了と判断します。

- 18項目すべてに`PASS / FAIL / BLOCKED`のいずれかが記録されている
- キーなしで実行できる項目に`NOT RUN`が残っていない
- 実Gemini、SMTP、前週データ、複数画面がない項目を`PASS`へ偽装していない
- 取得成功率95%以上を実測した
- ラベル付きカテゴリ一致率80%以上を実測した
- API原価100円/人日以下を、現在の単価設定付きで実測した
- 実個人データや秘密情報が証跡へ含まれていない
- インストーラーと証跡zipのSHA-256を保存した
