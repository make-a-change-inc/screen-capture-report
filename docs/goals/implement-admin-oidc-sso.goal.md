# GOAL: 企業別OIDC SSOを実装する

## Objective

企業ごとの外部IdPを安全に接続し、ローカル認証・MFAと併用可能なOIDC SSOを提供する。IdP未設定時は利用可能に見せず、設定済み企業だけSSOを開始できるようにする。

## Requirements

1. Ownerだけがissuer、client ID、client secret、許可メールドメイン、初回role、状態を設定できる。
2. client secretと一時的なPKCE verifierはAES-GCMで暗号化し、stateとnonceはハッシュで保存する。
3. Authorization Code Flow + PKCE S256を使い、callback URLをリクエストoriginに固定する。
4. DiscoveryのissuerとHTTPS endpointを検証し、ID tokenはJWKSのRS256署名、issuer、audience、azp、exp、iat、nonce、sub、emailを検証する。
5. 許可ドメイン外、停止ユーザー、期限切れ・再利用state、署名・claim不正を拒否する。
6. 初回SSOユーザーは設定されたManagerまたはAuditorとして作成し、既存ユーザーのrole・状態を優先する。
7. SSO成功時は既存と同じHttpOnly Cookieセッションを発行し、ログイン方法を監査する。

## Acceptance

- 未設定企業のSSO開始は404、Managerによる設定更新は403になる。
- RS256署名とclaim bindingの自動テストが成功する。
- Workerテスト、チェック、ビルド、Cloudflare dry-run、本番未認証401が成功する。
