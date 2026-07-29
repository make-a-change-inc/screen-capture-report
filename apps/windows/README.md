# Screen Capture Report for Windows

Windows 10 22H2 / Windows 11 x64向けの、プライバシー優先PC業務分析POCアプリです。Windowsのシステムトレイで常駐し、同意済みの業務時間内だけ画面を取得して、Geminiで構造化した業務ログ、本人向け日報、経営向け週次改善レポートを生成します。

このアプリは業務改善専用です。人事評価、査定、懲戒、従業員ランキング、常時監視には利用しません。経営向け出力にはスクリーンショット、ウィンドウタイトル、分単位の個人行動を含めません。

## POCで実装される流れ

1. 初回起動時に目的、取得内容、保持期間、停止方法を表示し、明示同意を得ます。同意前には取得しません。
2. 設定した稼働曜日・勤務時間中、原則60秒間隔でアクティブウィンドウまたは全モニターを取得します。既定は月〜金で、日をまたぐ勤務枠はPOC対象外です。
3. 一時停止、勤務時間外、Windowsロック中、5分以上の離席中、除外対象画面は取得せず、状態だけを記録します。
4. 画像を暗号化して一時保存し、長辺1280px以下の画像だけをGeminiへ送って、カテゴリ・要約・信頼度・推定時間・根拠capture IDをJSONで受け取ります。
5. 解析成功後、生画像は既定で即時削除します。失敗した解析はSQLiteキューに残り、ネットワーク復旧・再起動後に再試行します。
6. 本人向け日報は勤務終了後、解析キューの端数処理を待って生成します。経営向け週次レポートは完了週を後続曜日でも回収します。日報メールと経営メールは、それぞれ宛先が設定されている場合だけ送信します。

## データ保護

- 保存先: `%LOCALAPPDATA%\ScreenCaptureReport`
- APIキー、SMTPパスワード: Windows Credential Manager
- 暗号鍵: Windows DPAPIで現在のWindowsユーザーへバインド
- 画像・レポート・SQLite内の機微テキスト: Fernet暗号化
- 生画像: 解析成功後に既定で即時削除。デバッグ保持を有効にしても最大24時間
- 派生ログ・集計: 既定30日
- レポート: 既定90日
- 除外判定: 画面ピクセルを読む前に実行。除外時はルールIDだけを記録
- 運用ログ: ID、状態、件数、サイズ、例外クラスのみ。画面内容・秘密情報・メール本文を出力しない

AI事業者による保持・学習利用・再委託・国外移転は、アプリコードでは保証できない契約事項です。実従業員データを使う前に、導入企業が契約、設定、法的根拠、従業員説明を承認する必要があります。

## エンドユーザー向けインストール

ビルド済みの `ScreenCaptureReport-Setup-<version>-x64.exe` を起動します。管理者権限は不要で、`%LOCALAPPDATA%\Programs\ScreenCaptureReport` へper-userインストールされます。

Inno Setup版がない場合は、zipを展開してPowerShellから実行します。

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
```

Windowsログイン時の自動起動は、インストール時または設定画面で明示的に選択した場合だけ有効になります。

## 初期設定

初回起動で次を入力します。

- Gemini APIキー（必須）
- 従業員識別子・部署（必須。資格情報ストアへ保存）
- 訂正・削除・事故連絡先（必須）
- 本人向け日報のメールアドレス（任意）
- 経営向け週次レポートのメールアドレス（任意）
- SMTPユーザーとアプリパスワード（メール利用時）
- 勤務開始・終了時刻
- 稼働曜日（0=月〜6=日、既定は月〜金）
- 目的・取得・保持への同意

APIキーとSMTPパスワードは`config.json`やSQLiteには保存されません。

## トレイメニュー

- 取得を開始 / 一時停止
- 今すぐ取得
- 今すぐ解析
- 日報を生成
- 週次レポートを生成
- 最新の日報を開く
- レポートと画像を見る（本人日報、保持中画像、管理者共有プレビュー）
- 管理サーバーへ同期
- 今日の画像を削除
- データフォルダを開く
- 設定
- 終了

取得中はアイコン右下が緑、一時停止中はグレーになります。開始・停止は状態イベントとして保存され、明示停止・終了中は成功率や未分類時間の対象外です。表示される操作は実処理へ接続されており、未実装ボタンはありません。

起動時は通知領域へアイコンを表示してから取得サービスを開始します。Windowsがアイコンをオーバーフローへ格納した場合は、タスクバー右下の`^`内に表示されます。Explorerが再起動された場合も通知領域へ再登録されます。アイコンの表示処理自体が失敗した場合は、画面取得を開始せず終了します。

## 開発環境

推奨はWindows上のPython 3.12です。
以下のコマンドはリポジトリの`apps/windows`ディレクトリで実行します。

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
.\.venv\Scripts\python.exe -m ruff check src tests
.\.venv\Scripts\python.exe -m mypy src
.\.venv\Scripts\python.exe -m pytest
```

macOS/Linuxでは、Windows APIをフェイク化した単体・統合・契約テストだけを実行できます。実アプリ起動とWindowsバイナリ生成はできません。

## Windowsビルド

```powershell
.\scripts\build_windows.ps1
```

このスクリプトは品質ゲートを再実行してからPyInstaller onedirを作成し、`iscc.exe`があればInno Setupインストーラも生成します。Inno Setupがなければzipを作成します。PyInstallerはクロスコンパイル非対応なので、macOSで生成したspecだけをWindows完成証拠にはできません。

リポジトリルートの`.github/workflows/windows-ci.yml`は、Pull Requestまたは`main`の`apps/windows/**`が変更された場合、GitHubのWindows 2022ランナーで品質ゲート、PyInstallerビルド、起動前同意のfail-closed、二重起動防止を確認し、ハッシュ付き成果物を保存します。このCIはWindows Server上の非対話スモークであり、Windows 10/11のトレイ操作、Win+L、複数モニター、DPAPI、実APIを含む対話E2Eの代替にはなりません。

## 精度・成功率・原価の測定

日次の取得成功率とAPI原価:

```powershell
.\.venv\Scripts\python.exe -m src.cli metrics 2026-07-16
```

人手ラベル用CSVの出力:

```powershell
.\.venv\Scripts\python.exe -m src.cli export-labels 2026-07-16 .\labels-2026-07-16.csv
```

`expected_category`列を人が入力した後の一致率:

```powershell
.\.venv\Scripts\python.exe -m src.cli accuracy .\labels-2026-07-16.csv
```

目標は取得成功率95%以上、カテゴリ一致率80%以上、全API原価100円/人日以下です。ラベル、usage metadata、単価設定が不足している場合は`unmeasured`となり、合格扱いにはなりません。

## 管理Web同期

設定画面で管理API URL、端末アップロードトークンを入力し、`server-sync-v1`へ別途同意した場合だけ、確定済みの管理者向け週次レポートを送信します。本人日報、キャプチャ画像、ウィンドウタイトルは送信しません。

管理Webのソースはリポジトリルートの`admin-web/`にあります。Cloudflare Workerが管理UIと端末APIを提供し、D1へAES-256-GCMで暗号化した週次本文を保存します。`apps/windows`からローカル検証する場合は以下です。

```powershell
cd ..\..\admin-web
npm install
npm test
npx wrangler deploy --dry-run
```

本番作成と公開には`wrangler login`によるCloudflare認証が必要です。詳細仕様は[Report Viewer and Management Sync MVP v1](docs/mvp-v1-spec.md)を参照してください。

## 実Windows E2E

[Windows E2Eチェックリスト](docs/windows-e2e-checklist.md)を、クリーンなWindows 10 22H2またはWindows 11 x64環境で実行してください。少なくとも、同意前非取得、60秒周期、トレイ、一時停止、除外、離席、Win+L、オフライン再送、再起動復旧、日報、週次レポート、アンインストールを確認します。

## 要件・判断記録

- [Windows POC要件](docs/requirements-windows.md)
- [Fable 5 Grill-me判断記録](docs/decision-record.md)
- [POCプライバシー・法務ゲート](docs/privacy-and-poc-gates.md)
- [アクセス制御マトリクス](docs/access-control-matrix.md)
- [脅威モデル](docs/threat-model.md)
- [実行状態](execution-notes.md)

## POC対象外

- 生産性の高低による社員比較、ランキング、査定、懲戒
- 画面の常時管理者監視
- AI提案の自動実行
- 3キャラクター/複数人格分析
- 自動アップデート
- コード署名、本番配布、新規有料契約
- Windows版からのmacOS機能提供（macOS版は`apps/macos`で別管理）
