# Screen Capture Report Admin

Cloudflare Workers + D1で動作する管理者ダッシュボードです。

## Production

- URL: <https://screen-capture-report-admin.m-okamura-8e7.workers.dev>
- Worker: `screen-capture-report-admin`
- D1: `screen-capture-report-admin-db`（APAC）

管理パスワードとレポート暗号鍵の復旧コピーは、現在のWindowsユーザーだけが
復号できる`admin-web/.production-credentials.dpapi`に保存されています。
管理パスワードを確認するには次を実行します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\show-production-admin-key.ps1
```

このファイルと表示されたキーはGit、メール、チャットへ添付しないでください。

## Runtime secrets

- `ADMIN_EMAIL`: 固定の管理者メールアドレス
- `ADMIN_PASSWORD_HASH`: 管理パスワードのSHA-256 hex
- `BOOTSTRAP_ADMIN_HASH`: 移行用の旧名（`ADMIN_PASSWORD_HASH`未設定時のみ使用）
- `REPORT_ENCRYPTION_KEY_V1`: 32-byte AES鍵のbase64

管理画面と管理APIは固定メールアドレスとパスワードを検証します。
端末APIは、D1にSHA-256だけ保存した端末Bearer tokenを必要とします。

サーバーが受け付けるのは確定済み`weekly / management`レポートだけです。本人日報と画像を受け取るAPIはありません。

## Cloudflare deployment

このWorkerはCloudflare Workersへ配置します。

```powershell
npm install
npm run db:create
npm run db:migrate
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put REPORT_ENCRYPTION_KEY_V1
npm run deploy
```

`db:create`が書き込んだD1 IDを含む`wrangler.jsonc`を確認してからmigrationとdeployを行います。
