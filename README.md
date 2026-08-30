# 友達データ帳（サーバー共有データベース版）

## 構成（Cloudflare Workers + 静的アセット + KV）
- `wrangler.toml` … Workerの設定ファイル（KVバインディング・静的ファイルの場所を指定）
- `public/index.html` … アプリ本体（静的ファイル）
- `worker.js` … `/api/data` `/api/data-light` を処理し、それ以外は `public/` の静的ファイルを返すWorker

KVの中身は認証なし・誰でも読み書きできる共有データベースです。

## セットアップ済みの内容
- KVネームスペース名: `FRIEND_KV`
- Namespace ID: `f488d1f76d7e4782a29dfa703b81375b`（`wrangler.toml` に記載済み）
- Cloudflareプロジェクト名: `cloudflare-friend-data-pages`
- 本番ブランチ: `cloudflare/friend-data-pages`

## APIエンドポイント
- `GET /api/data` … 全データをJSON配列で取得
- `POST /api/data` … 送ったJSON配列でまるごと上書き保存
- `GET /api/data-light` … 画像等の重いフィールドを除いた軽量版（Claudeがチャット内で内容を確認する用）

## Claude（このチャット）が今後コードを変更するときの運用
1. コードを直す前に、デプロイ後のURLの `/api/data-light` を取得して現在の実データを確認する
2. 修正後のファイルを見せるときは、その時点の実データを `INITIAL_DATA` として埋め込んだ状態で渡す
3. データ取得に失敗しても、画面に表示済みのデータを消したりエラーで上書きしたりしない

<!-- テスト更新: 2026-08-30 02:50:07 これはブランチ分離の動作確認用の変更です -->
