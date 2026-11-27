# Changelog

[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) と [Semantic Versioning](https://semver.org/lang/ja/) に準拠する。

## [Unreleased]

## [1.1.0] - 2026-11-27

### Added

- PDF の取得方法を `PDF_DEEPLINK_ZOTERO_FILE_SOURCE` で選べるようにした。PDF を返す HTTP の経路を別に用意しなくても、Zotero の利用形態に合わせて PDF を開ける
    - `local`: ローカルの Zotero の Local API が返す `file://` のパスを読む。読み取りは `PDF_DEEPLINK_ZOTERO_LOCAL_DIRS` で許可したディレクトリの中に限る
    - `web`: zotero.org の Web API に API キーを付けて要求し、転送先から取得する
    - `webdav`: Zotero が WebDAV に置いた `<キー>.zip` から PDF を取り出す
    - `template`: 従来の、PDF を返す HTTP の経路のテンプレートから取得する
- `PDF_DEEPLINK_ZOTERO_ENDPOINT` に `https://` を指定できるようにした。zotero.org の Web API から一覧と書誌を取得できる。zotero.org にファイルを置かず WebDAV で同期しているライブラリでも、PDF の添付がある文献を一覧に表示する
- API キーを `PDF_DEEPLINK_ZOTERO_API_KEY` または `PDF_DEEPLINK_ZOTERO_API_KEY_FILE` で渡すと、一覧、書誌、PDF の要求に付けるようにした。WebDAV の資格情報も環境変数またはファイルで渡せる

### Changed

- `PDF_DEEPLINK_ZOTERO_FILE_PATH` を、取得方法が `template` の場合だけ必須とした。`PDF_DEEPLINK_ZOTERO_FILE_SOURCE` を指定せず `PDF_DEEPLINK_ZOTERO_FILE_PATH` だけを指定した設定は、従来どおり動作する

## [1.0.0] - 2026-11-26

### Added

- 警告とエラーのバナーを閉じるボタン
- ページをまたぐ範囲を指すリンクの発行と強調表示

### Changed

- リンクの形式を変えた。0.1.0 で発行したリンクを開くと「リンクの一部が正しくない」旨が表示され、文書の先頭が開くため、リンクを発行し直す。形式の詳細は [docs/link-format.md](docs/link-format.md) を参照のこと
    - `page` を除き、`rects` の各ページの先頭の矩形に `ページ番号:` を付けて範囲のページを表す
    - 矩形の区切りを `;` から `_` に変えた
    - 複数ページにまたがるリンクでは、`label` にページラベルの範囲を入れる
    - 同じ名前のパラメータが複数ある場合と、ページ番号が 100000 を超える場合はエラーとする
- 文章を選択してリンクを発行する際、段組ごとに最初の行、中間の行、最後の行の矩形にまとめ、長い選択からもリンクを作れるようにした
- PDF の SHA-256 がリンクの `sha256` と一致しない場合も、リンクのページが PDF にあれば範囲を強調表示し、PDF が更新されていて位置がずれている可能性があることを警告するようにした
- リンクの `sha256` を SHA-256 の先頭 16 桁で発行し、解釈では 16〜64 桁を受け付けるようにした
- 警告とエラーの文言を、状況が分かる簡潔な表現にした。入力欄「目印」を「検索用テキスト」に、ボタン「目印で検索」を「一致する箇所を検索」に改めた
- 他のサイトのリンクから画面を開けるようにした。画面は iframe に埋め込めない
- 開発環境に、コミット時のシークレットの検出、整形、リントと、プッシュ時の型検査とテストを追加した
- ESLint（typescript-eslint）の対応範囲に合わせて、TypeScript のバージョンを 6.0 系に変えた

### Fixed

- 文章の選択から作る検索用テキストの初期値で、行をまたぐ語のつなぎ方が PDF.js の検索と異なり、一致する箇所を検索しても見つからない問題を修正した（行末のハイフン、漢字と仮名の行末、結合文字）
- ページの表示領域（CropBox）の外にある見えない文字が、選択した範囲と検索用テキストに含まれる問題を修正した
- PDF 以外の添付を、PDF の取得の API から返していた問題を修正した
- 10 ページを超える長い選択で、PDF.js が破棄した先頭のページが選択から抜け落ちたままリンクが発行される問題を修正した。この場合は範囲が大きすぎる旨を表示する

## [0.1.0] - 2026-11-26

### Added

- PDF 上で選択した文章や矩形の範囲を指すリンクの発行、およびリンクを開いた際の該当箇所への移動と一時的な強調表示
- 版の照合（PDF の SHA-256 がリンクの `sha256` と一致しない場合は、範囲が適用されず、目印が表示される）
- Zotero Web API v3 互換の API からの文献の一覧、書誌、PDF の取得（一覧は検索、並び替え、表示件数の選択、ページ送りに対応する）
- 出典（著者、発行年、タイトル、掲載誌、DOI、ページ、目印）のコピー
- コンテナで実行するための Dockerfile と、Unix ソケットでの待ち受け

[Unreleased]: https://github.com/sakashita44/pdf-deeplink/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/sakashita44/pdf-deeplink/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/sakashita44/pdf-deeplink/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/sakashita44/pdf-deeplink/releases/tag/v0.1.0
