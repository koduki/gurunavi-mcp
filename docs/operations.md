# Operations

## Bootstrap

TerraformはSecret ManagerのSecretコンテナを管理しますが、秘密値をTerraform stateへ保存しません。そのため初回だけ二段階適用します。

1. API、Artifact Registry、Secretコンテナ、KMS keyをtarget apply
2. Secret Managerへversionを標準入力から追加
3. コンテナをbuild/push
4. immutable image URLを `terraform.tfvars` に設定
5. full plan/apply

Cloud Runはデプロイ時にSecretへのアクセスと指定versionの存在を検証するため、version追加前のfull applyは失敗します。

## Secret一覧

| 環境変数 | 用途 | 推奨rotation |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth client | client変更時 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth secret | インシデント／定期 |
| `TOKEN_SIGNING_SECRET` | access/confirmation/interaction JWT | インシデント／定期 |
| `SESSION_ENCRYPTION_KEY` | ローカルfallbackとmigration | インシデント／定期 |

productionのブラウザ状態は主にKMS envelope encryptionで保護します。

Secretは `latest` ではなく `secret_version` で固定します。rotation時は新versionを追加し、変数を更新して新revisionを出します。JWT signing secretをrotationすると既存access token、確認token、interaction URLは無効になります。

## Google OAuth

OAuth clientのauthorized redirect URI:

```text
${PUBLIC_BASE_URL}/auth/google/callback
```

OAuth consent screenで必要なのは `openid` と `email` です。許可するGoogleアカウントを `allowed_emails` に列挙します。

MCPクライアントはDynamic Client Registrationを使えます。認可はpublic client + Authorization Code + PKCE S256のみで、client secretは発行しません。

## Release

推奨:

1. `npm ci`
2. `npm run check`
3. fixture差分とTool schemaをreview
4. Cloud Buildでimage作成
5. image digestをTerraformへ固定
6. `terraform plan`
7. workerへ先に新revisionを出し、検索・詳細・ログインhandoffをsmoke test
8. frontendを更新
9. 予約送信は無効のまま `reservation_prepare` まで受入試験
10. 明示承認後だけmutation flagを有効化

## Smoke test

- `/healthz` と `/readyz`
- OAuth metadata二種
- DCR、Google login、allowed email拒否
- `restaurant_search` のPR優先disclosure
- `restaurant_get` のJSON-LD + table fallback
- `reservation_options_get` の二段階取得と、座席別の即予約／request判定
- 同時刻の複数座席で `slot_id` が必須になること
- `reservation_prepare` が席を送信しない
- 予約slot URLの店舗・日付・人数・時刻改ざんが拒否されること
- confirmation tokenのreplay拒否
- interaction URLがfragment tokenである
- unknown hostが専用ブラウザで遮断される
- CAPTCHA画面で自動突破せず停止する

## Monitoring

推奨メトリクス:

- HTTP 5xx、latency、instance count
- `GURUNAVI_PAGE_CHANGED` 件数
- `GURUNAVI_TEMPORARILY_BLOCKED` 件数
- OAuth failure、worker identity failure
- reservation prepare / submit / accepted / requested / cancelled
- Cloud Tasks retryとdead task
- KMS decrypt error
- Firestore read/write error

ログに予約者情報やtokenを追加しないでください。調査キーは内部 `reservation_id` と `interaction_id` を使います。

## Rollback / kill switch

最優先のkill switch:

```hcl
enable_reservation_submit = false
```

これでfrontendとworkerの両方が実予約・取消を拒否します。次にCloud Run trafficを既知の正常revisionへ戻します。画面変更だけなら検索／詳細を継続するかも含めて判断し、誤予約の可能性がある場合はworker全体を停止します。

## Firestore TTL

Terraformは期限付きcollection groupの `expiresAt` にTTL policyを設定します。値はFirestore Timestampです。OAuth client metadataだけはDCR継続利用のためTTLなしです。

TTL削除は即時ではありません。アプリケーションもread時に期限を検証し、期限切れ値を利用しません。

## Site change response

`page_changed` が発生した場合:

1. 実送信flagを無効化
2. 対象URLと観測時刻だけを確認し、PIIを収集しない
3. 公式ページを手動で確認
4. DOM fixtureを更新
5. parser unit testと非破壊smoke test
6. CTAと成功レシートを二人review
7. 段階的に再有効化
