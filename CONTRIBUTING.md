# Contributing

## Development

```bash
npm ci
npx playwright install --with-deps chromium
npm run check
```

コードはTypeScript strict mode、ES modules、Node.js 24を前提にします。ファイル編集時は次を守ってください。

- 汎用browser primitivesをMCP Toolとして公開しない
- 新しい外部副作用はprepare/confirm/submitに分ける
- credentialsやCookieをTool引数へ追加しない
- 新しいURL遷移先は明示allowlistとテストを追加する
- DOM selector変更にはfixtureと失敗時のsafe stopテストを追加する
- 生HTMLをTool結果へ返さない
- 予約成功は提供元の明確なreceiptを確認してから記録する

`package.json` の `overrides` は既知の依存脆弱性を解消するための固定です。MCP SDKまたはGoogle Cloud依存の更新時は、`npm audit --omit=dev --audit-level=moderate` とHTTP契約テストを通してから削除・変更してください。

## Pull request checklist

- `npm run check` が成功する
- production依存の `npm audit` がmoderate以上0件
- Terraformを `terraform fmt -check -recursive` と `terraform validate` で確認する
- 予約・取消のmutationが既定で無効のまま
- PIIとtokenがログに入らない
- READMEまたはinterface docsを更新する
- ぐるなびの最新UI、利用規約、予約ガイドを確認する
