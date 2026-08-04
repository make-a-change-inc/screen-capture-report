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

## Runtime configuration

- `ADMIN_EMAIL`: 固定の管理者メールアドレス（非秘密のWorker変数）
- `ADMIN_PASSWORD_HASH`: 管理パスワードのSHA-256 hex
- `BOOTSTRAP_ADMIN_HASH`: 移行用の旧名（`ADMIN_PASSWORD_HASH`未設定時のみ使用）
- `REPORT_ENCRYPTION_KEY_V1`: 32-byte AES鍵のbase64

管理画面と管理APIは企業コード、固定メールアドレス、パスワードを検証します。認証後の従業員、端末、週報、復号本文は企業コードに対応するテナントだけに制限されます。企業コードは平文保存せずSHA-256ダイジェストで照合します。
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

## External integrations

### Cloudflare Email Service

Email Sendingが未接続の間、メール配信APIは成功を返さず、503と失敗履歴を保存します。
送信ドメインをCloudflare Email Serviceへonboardした後にだけ、次の非秘密設定を
`wrangler.jsonc`へ追加します。

```jsonc
{
  "vars": {
    "REPORT_EMAIL_FROM": "reports@onboarded.example"
  },
  "send_email": [
    {
      "name": "EMAIL",
      "allowed_sender_addresses": ["reports@onboarded.example"]
    }
  ]
}
```

送信元はonboard済みドメインに限定し、実在する管理下の受信先で配信履歴まで確認します。
Email ServiceのAPI tokenや資格情報はリポジトリへ保存しません。

### OIDC SSO

Google Workspaceを使う場合のcallback URLは次のとおりです。

```text
https://screen-capture-report-admin.m-okamura-8e7.workers.dev/api/auth/oidc/callback
```

issuer、client ID、許可ドメイン、初回roleはOwnerが管理画面から設定します。
client secretはチャットやGitへ記録せず、HTTPSの設定フォームへ直接入力し、
D1にはAES-GCM暗号化した値だけを保存します。
