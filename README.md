# Screen Capture Report

macOS版、Windows版、管理Webを1つのリポジトリで管理します。各アプリのOS依存コードと依存関係を分離しているため、片方の変更で他方の実装を置き換えません。

## 構成

| パス | 内容 |
| --- | --- |
| [`apps/macos/`](apps/macos/) | macOSメニューバーアプリ |
| [`apps/windows/`](apps/windows/) | Windowsシステムトレイアプリ |
| [`admin-web/`](admin-web/) | Cloudflare Workerによる管理画面・端末API |
| [`.github/workflows/`](.github/workflows/) | Windows検証と本番デプロイ |

## 開発

### macOS

```bash
cd apps/macos
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python -m src.main
```

詳しい設定とビルド方法は[`apps/macos/README.md`](apps/macos/README.md)を参照してください。

### Windows

```powershell
cd apps\windows
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --require-hashes -r requirements-lock.txt
.\scripts\build_windows.ps1
```

詳しい設定、テスト、配布方法は[`apps/windows/README.md`](apps/windows/README.md)を参照してください。

### 管理Web

```bash
cd admin-web
npm ci
npm test
npm run check
```

本番デプロイは、`main`の`admin-web/**`またはデプロイワークフローが変更されたときに、GitHubの`production`環境を経由して実行されます。

## ブランチ運用

変更は作業ブランチからPull Requestを作成し、レビュー後に`main`へマージします。macOS版とWindows版は同じ`main`に共存し、GitHub Actionsは変更された対象のパスに応じて実行されます。
