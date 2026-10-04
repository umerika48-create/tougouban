# 友達データ帳（サーバー共有データベース版）

## 構成（Cloudflare Workers + 静的アセット + KV）
- `wrangler.toml` … Workerの設定（KVバインディング `FRIEND_KV`、静的ファイルの場所）
- `public/index.html` … アプリ本体
- `worker.js` … API と静的ファイル配信

プロジェクト名 `cloudflare-friend-data-pages` / 本番ブランチ `cloudflare/friend-data-pages`
KV Namespace ID: `f488d1f76d7e4782a29dfa703b81375b`

認証なし。誰でも読み書きできる共有データベース。

## データの書き込み方（画面もClaudeも同じAPIを使う）
追加・更新・削除は **1人単位の操作** で行う。古い全体データで丸ごと上書きする事故を防ぐため。

| API | 内容 |
|---|---|
| `GET /api/data` | 全データ（JSON配列） |
| `GET /api/data-light` | 画像など重い項目を除いた軽量版 |
| `GET /api/check/<任意の文字列>` | data-lightと同じ（URLを変えて取得したい時用） |
| `POST /api/upsert` | 追加・更新。body は配列 または `{items:[...], force?:true}`。idが一致→なければ名前が一致する人を更新、それ以外は新規 |
| `POST /api/delete` | 削除。body は `{ids:[...], names:[...]}` |
| `GET /api/backups` | バックアップ一覧 |
| `POST /api/restore` | バックアップから復元。body は `{key:"..."}` |
| `POST /api/data` | 全データの置き換え（通常は使わない） |

## 事故防止の仕組み
1. 空配列での上書きは常に拒否（409）
2. 件数が半分未満に減る上書きは拒否（409。`force` で解除）
3. 書き込みの直前に、いまの内容を自動バックアップ
   - `friends-list-backup-<日時>` … 直近30件
   - `friends-list-daily-<日付>` … 1日1回（その日の最初の書き込み前の状態）、直近14日
4. サーバーが空でバックアップだけある（＝消えた）状態では、1人だけの追加も拒否。先に復旧する
5. 画面側：サーバーが空の時は予備データを表示したまま保存をブロックし、赤い警告を出す。通信失敗でも表示済みのデータは消さない

## 復旧の手順（データが消えた時）
1. `GET /api/backups` で一覧を見る
2. 戻したい時点の `key` を選び、`POST /api/restore` に `{"key":"..."}` を送る
   （復元の直前の状態も自動でバックアップされる）

## Claudeの作業ルール
- 変更前に `/api/data-light`（または `/api/data`）でサーバーの実データを確認する
- データを書き込む前に、必ず現在の全データをバックアップとして手元に取得しておく
- データの追加・修正は `/api/upsert` `/api/delete` で行い、`POST /api/data`（全置換）は使わない
- コードを変更したら、`INITIAL_DATA`（オフライン表示用の埋め込みデータ）も最新のサーバーデータに合わせる
- 変更後は、構文チェックと動作確認をしてからファイルを提示する。GitHubへの反映は「GitHub更新お願い」と言われた時だけ
