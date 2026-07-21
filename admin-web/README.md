# Screen Capture Report Admin

Sites Worker + D1で動作する管理者ダッシュボードです。

## Production

- URL: <https://screen-capture-report-admin.m-okamura-8e7.workers.dev>
- Worker: `screen-capture-report-admin`
- D1: `screen-capture-report-admin-db`（APAC）

管理APIキーとレポート暗号鍵の復旧コピーは、現在のWindowsユーザーだけが
復号できる`admin-web/.production-credentials.dpapi`に保存されています。
管理APIキーを確認するには次を実行します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\show-production-admin-key.ps1
```

このファイルと表示されたキーはGit、メール、チャットへ添付しないでください。

## Runtime secrets

- `BOOTSTRAP_ADMIN_HASH`: 管理画面APIキーのSHA-256 hex
- `REPORT_ENCRYPTION_KEY_V1`: 32-byte AES鍵のbase64

Sitesプロジェクト自体は所有者限定にし、管理APIでも`x-admin-key`を追加検証します。
端末APIはSites bypass tokenと、D1にSHA-256だけ保存した端末Bearer tokenの両方を必要とします。

サーバーが受け付けるのは確定済み`weekly / management`レポートだけです。本人日報と画像を受け取るAPIはありません。

## Cloudflare fallback

SitesがWorker成果物を受け付けない場合は、同じWorkerをCloudflare Workers無料枠へ配置します。

```powershell
npm install
npm run db:create
npm run db:migrate
npx wrangler secret put BOOTSTRAP_ADMIN_HASH
npx wrangler secret put REPORT_ENCRYPTION_KEY_V1
npm run deploy
```

`db:create`が書き込んだD1 IDを含む`wrangler.jsonc`を確認してからmigrationとdeployを行います。
