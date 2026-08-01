# Threat model

## 保護対象

- GoogleアカウントとOAuth access token
- ぐるなび／楽天のログインCookie
- 予約者の氏名、電話、メール
- 予約内容、確認トークン、提供元予約番号
- 実予約・取消という外部副作用
- ぐるなびとGCPへのアクセス権

## 主な脅威と対策

| 脅威 | 対策 |
|---|---|
| 未認証MCP利用 | Google OAuth、PKCE S256、メール許可リスト、1時間JWT |
| OAuth redirect差替え | DCRで登録済みredirect URIとの完全一致 |
| 認可code奪取 | 10分TTL、一回限り、PKCE verifier照合 |
| 二重予約 | prepare/submit分離、サマリーハッシュ、nonce消費、状態検証 |
| 同時刻の別座席を誤選択 | 座席別 `slot_id`、曖昧時の入力要求、確認済みslot URLの再照合 |
| エージェントの誤確認 | side-effect Toolの注記、完全サマリー、明示同意要求 |
| 資格情報の会話流入 | MCPスキーマにpasswordを持たず、本人専用ブラウザへ分離 |
| interaction tokenのログ漏洩 | URL fragmentで配送し、履歴から即時除去。queryとRefererへ出さない |
| interaction WebSocketの横取り | tokenを最初のメッセージで検証し、HTTP OriginとHostの一致を要求 |
| Cookie流出 | AES-256-GCM + per-object DEK + Cloud KMS wrapping |
| SSRF / open proxy化 | 操作enum、Gurunavi URL完全検証、任意URL・任意JSなし、private/link-local/metadata通信の遮断 |
| OAuth/workerなりすまし | Google署名OIDCのaudienceとservice-account emailを照合 |
| CAPTCHA回避 | 自動回避せず本人操作か停止 |
| DOM変更による誤クリック | 限定ラベル、成功レシート確認、不明時 `page_changed` |
| 提供元コンテンツのprompt injection | 生HTMLを返さず正規化。外部文字列を命令として扱わない旨をTool/Resourceに明示 |
| PIIログ漏洩 | Authorization、Cookie、token、phone、emailをredact。interaction HTTPログを省略 |
| 永続データ過多 | interaction/OAuth/session/reservationにTTL。送信後は予約者PIIと要望を削除。店舗カタログを保存しない |

## 権限分離

### Frontend service account

- Firestore read/write
- Secret Manager read
- Cloud Tasks enqueue
- browser worker向けGoogle ID token取得

### Worker service account

- Firestore read/write
- Secret Manager read（token signingとsession encryptionの2 Secretのみ）
- KMS encrypt/decrypt

### Tasks invoker service account

- frontendのtask routeへOIDC tokenで到達するためだけに使用

workerの内部routeはCloud Run IAMの公開設定だけに依存しません。署名tokenをアプリケーションでも検証します。

## 残余リスク

- 提供元の利用規約や画面仕様は変更されうる
- headless browser自体の0-dayや依存ライブラリ脆弱性
- ぐるなび／楽天のログイン仕様変更
- 店舗側が予約内容を後から変更・拒否する可能性
- request予約が確定予約ではないことをユーザーが誤解する可能性
- Cloud Run request URL、アプリログ以外の組織レベル監査ログ設定
- 専用ブラウザのスクリーン画像がユーザー端末上に表示されること

依存更新、定期的な画面fixture更新、Cloud Audit Logs、Security Command Center、Secret rotation、最小IAMのレビューを運用へ組み込んでください。

## インシデント時

1. `enable_reservation_submit=false` で予約・取消を即時停止
2. frontend/workerの新revisionへtrafficを戻すか、サービスを停止
3. OAuth signing secretとinteraction/session secretをrotation
4. KMS key、Cloud Audit Logs、Firestore accessを調査
5. 影響した予約を提供元と店舗で照合
6. 必要ならログイン済みセッションを全削除
