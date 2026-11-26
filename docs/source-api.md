# 取得元 API の仕様

この文書では、`pdf-deeplink` の取得元となる Zotero API v3 互換の API や中継サーバを独自に用意する読者に向けて、サーバが送信するリクエストと求める応答を規定する。

導入、利用形態ごとの設定、起動手順については、[README](../README.md) を参照のこと。

## 接続方式と共通リクエスト

- 接続方式: `http://<ホスト>[:<ポート>]`、`https://<ホスト>[:<ポート>]`（パスは `/` のみ）、または Unix ドメインソケット（`unix:<パス>`）。接続先は `PDF_DEEPLINK_ZOTERO_ENDPOINT` で指定される。
- 共通リクエスト: 取得元 API へのリクエストはすべて `GET` で送信され、`Zotero-API-Version: 3` ヘッダが付与される。API キーが設定されている場合は、`Zotero-API-Key` ヘッダも付与される。

## 文献一覧・書誌・PDF 確認のエンドポイント

一覧の取得、書誌の取得、および PDF 本体の取得前に行う確認では、次のエンドポイントへリクエストが送信される。`<apiPath>` は `PDF_DEEPLINK_ZOTERO_API_PATH`（末尾の `/` を除いた値）を表す。

| 用途             | リクエスト                                                                                                                                           | 求める応答                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文献一覧の取得   | `GET <apiPath>/items/top?start=<開始位置>&limit=100&sort=<項目>&direction=<並び順>`（検索時は `q=<検索語>` を付与）。100 件ずつ先頭 5,000 件まで走査 | HTTP 200 の JSON 配列（Zotero API v3 形式）。総件数を示す `Total-Results` ヘッダを返すと走査回数を抑えられる                                             |
| 書誌情報の取得   | `GET <apiPath>/items/<8 文字の英大文字・数字>`（`data.parentItem` がある場合は親アイテムも取得）                                                     | HTTP 200 の JSON オブジェクト（該当なしは HTTP 404）。添付アイテムは `data.itemType: "attachment"` かつ `data.contentType: "application/pdf"` であること |
| PDF 取得前の確認 | `GET <apiPath>/items/<8 文字の英大文字・数字>`                                                                                                       | 書誌情報の取得と同じ形式。PDF 添付であることが確認できた場合に限り、PDF 本体の取得へ進む                                                                 |

- 文献一覧の `sort` には `dateModified`、`dateAdded`、`title`、`creator`、`date` のいずれか、`direction` には `asc` または `desc` が指定される。`Total-Results` ヘッダが省略された場合は、応答件数が 100 件未満になるまで順に取得される。
- 画面表示と出典の生成には `data.title`、`data.creators`、`data.date`、`data.publicationTitle`、`data.DOI` が用いられる。

## PDF 本体の取得

PDF 添付の確認後、`PDF_DEEPLINK_ZOTERO_FILE_SOURCE` の値に応じて次のリクエストが送信される。

### `local`

- リクエスト: サーバは取得元 API へ `GET <apiPath>/items/<8 文字の添付キー>/file` を送信する。
- 求める応答: HTTP 302 と、ローカルの `file:` URL（ネットワーク上のパスは不可）を指す `Location` ヘッダ。サーバは指定されたパスを書き換えずにそのまま開く。

### `web`

- リクエスト: サーバは取得元 API へ `GET <apiPath>/items/<8 文字の添付キー>/file` を送信する。
- 求める応答: HTTP 200 の PDF バイト列、または `https://` で始まる絶対 URL へのリダイレクト。サーバは HTTPS でないリダイレクト先には従わず、リダイレクト先へのリクエストには `Zotero-API-Key` ヘッダを送信しない。

### `webdav`

- リクエスト: サーバは `PDF_DEEPLINK_ZOTERO_WEBDAV_URL` の配下にある `zotero/<8 文字の添付キー>.zip` へ `GET` を送信する。WebDAV の認証情報が設定されている場合は、HTTP Basic 認証（`Authorization: Basic`）を付与する。
- 求める応答: HTTP 200 の ZIP アーカイブ。

### `template`

- リクエスト: サーバは取得元 API と同一の接続先へ、`PDF_DEEPLINK_ZOTERO_FILE_PATH` の `{key}` を 8 文字の添付キーへ置換したパスで `GET` を送信する。
- 求める応答: HTTP 200 の PDF バイト列。
