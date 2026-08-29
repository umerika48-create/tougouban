# 友達データ帳（サーバー共有データベース版）

## 構成
- `index.html` … アプリ本体（静的ファイル）
- `functions/api/data.js` … 読み書き用API（GET/POST）
- `functions/api/data-light.js` … Claude確認用の軽量版API（GETのみ、画像等は除外）

データの保存先は **Cloudflare KV**。認証なし・誰でも同じデータを読み書きできる共有DBです。

## セットアップ手順（さくらこさんに数クリックお願いする部分）

### 1. GitHubリポジトリを作成 or 既存リポジトリに配置
このフォルダの中身（`index.html` と `functions/` フォルダ）をリポジトリのルートに置きます。

### 2. Cloudflare Pagesでプロジェクトを作成
1. Cloudflareダッシュボード → **Workers & Pages** → **Pages** → **Create a project**
2. 「Connect to Git」で上記のリポジトリを選択
3. ビルド設定は特に不要（静的ファイルなので、ビルドコマンドは空欄でOK）

### 3. KVネームスペースを作成
1. Cloudflareダッシュボード → **Workers & Pages** → **KV** → **Create a namespace**
2. 名前は何でもOK（例：`friend-data`）

### 4. KVをPagesプロジェクトにバインド
1. 作成したPagesプロジェクト → **Settings** → **Functions** → **KV namespace bindings**
2. 「Add binding」
   - **Variable name**: `FRIEND_KV` （←この名前は固定。コード側でこの名前を参照しています）
   - **KV namespace**: 手順3で作ったネームスペースを選択
3. **Production** と **Preview** の両方に設定してください（片方だけだとプレビューか本番のどちらかでデータが読めません）
4. 設定後、Pagesの再デプロイが必要な場合があります（Deployments画面から「Retry deployment」）

### 5. 動作確認
- デプロイ後のURL（例：`https://xxxx.pages.dev`）にアクセスして、友達を1人追加してみる
- ブラウザをリロードしても消えなければ成功
- 別の端末・別のブラウザから同じURLを開いても同じデータが見えれば成功

## APIエンドポイント
- `GET /api/data` … 全データをJSON配列で取得
- `POST /api/data` … 送ったJSON配列でまるごと上書き保存
- `GET /api/data-light` … 画像等の重いフィールドを除いた軽量版（Claudeがチャット内で内容を確認する用）

## Claude（このチャット）が今後コードを変更するときの運用
1. コードを直す前に `https://（デプロイ後のURL）/api/data-light` を取得して現在の実データを確認する
2. 修正後のファイルを見せるときは、その時点の実データを `INITIAL_DATA` として埋め込んだ状態で渡す
3. データ取得に失敗しても、画面に表示済みのデータを消したりエラーで上書きしたりしない
