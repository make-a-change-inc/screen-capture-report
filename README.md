# Screen Capture Report Admin

Sites Worker + D1で動作する管理者ダッシュボードです。

## Runtime secrets

- `BOOTSTRAP_ADMIN_HASH`: 管理画面APIキーのSHA-256 hex
- `REPORT_ENCRYPTION_KEY_V1`: 32-byte AES鍵のbase64

Sitesプロジェクト自体は所有者限定にし、管理APIでも`x-admin-key`を追加検証します。
端末APIはSites bypass tokenと、D1にSHA-256だけ保存した端末Bearer tokenの両方を必要とします。

サーバーが受け付けるのは確定済み`weekly / management`レポートだけです。本人日報と画像を受け取るAPIはありません。
