# GOAL: 管理機能 Phase 1を本番実装する

## Objective

`docs/admin-product-requirements-v1.md` を唯一の確定要件として、WORK VISIBILITY AIの管理機能Phase 1を実装し、GitHub PRとCloudflare本番デプロイまで完了する。

## Constraints

- 管理サーバーへ生画像、ウィンドウタイトル、本人日報、詳細作業ログを追加送信しない。
- 個人ランキングを実装しない。
- 実データ/API/永続化がない機能を、動作するUIとして表示しない。
- 既存Windowsクライアントの確定週報アップロード互換性を維持する。
- パスワードをlocalStorage/sessionStorageへ保存しない。
- すべての管理APIを認証・テナントスコープで保護する。
- D1スキーマ変更は冪等で、既存本番データを破壊しない。
- ユーザーの既存変更を上書きしない。

## Deliverables

1. サーバー側Cookieセッションによるログイン・ログアウト・認証確認。
2. 経営ダッシュボード、業務分析、AI化候補、レポート、従業員管理、端末・収集状況、分類ルール・データ品質、プライバシー・データ管理、監査ログ、組織設定の実ページ。
3. 実ページに必要なテナントスコープAPI、監査、組織設定、保持処理。
4. 日本語UI、レスポンシブナビ、キーボード操作、明確なloading/empty/error/partial状態。
5. 要件・認証・テナント分離・XSS・保持処理を検証する自動テスト。
6. Gitブランチ、意図した差分だけのコミット、Push、PR、CI成功、Cloudflare本番反映確認。

## Execution order

1. 現行コードとD1スキーマを確認し、後方互換なスキーマを追加する。
2. 認証をCookieセッションへ移行し、自己端末登録を既定拒否する。
3. 管理データAPIをテナントスコープで拡張する。
4. `.replace()` ベースの画面合成を廃止し、単一の明示的な管理SPAへ置換する。
5. 各ページを実データに接続し、推定値と実測値、欠損を区別する。
6. テスト、Worker dry-run、差分・秘密情報・アクセシビリティを検査する。
7. PushしてPRを作成し、レビュー可能な説明と検証結果を記載する。
8. PRをmainへ反映し、GitHub ActionsによるCloudflareデプロイを監視する。
9. 本番HTML/APIをスモーク確認し、完了結果を報告する。

## Definition of done

`docs/admin-product-requirements-v1.md` のPhase 1完了条件をすべて満たし、未実装のPhase 2/3を実装済みと誤認させる表示がなく、PRと本番デプロイURLを提示できること。
