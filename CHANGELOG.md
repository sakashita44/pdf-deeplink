# Changelog

[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) と [Semantic Versioning](https://semver.org/lang/ja/) に準拠する。

## [Unreleased]

### Changed

- 開発環境に、コミット時の秘密値の検出、整形、リント、および push 時の型検査とテストを追加した。ESLint（typescript-eslint）に合わせて、TypeScript のバージョンを 6.0 系に変更した

## [0.1.0] - 2026-11-26

### Added

- PDF 上で選択した文章や矩形の範囲を指すリンクの発行、およびリンクを開いた際の該当箇所への移動と一時的な強調表示
- 版の照合（PDF の SHA-256 がリンクの `sha256` と一致しない場合は、範囲が適用されず、目印が表示される）
- Zotero Web API v3 互換の API からの文献の一覧、書誌、PDF の取得（一覧は検索、並び替え、表示件数の選択、ページ送りに対応する）
- 出典（著者、発行年、タイトル、掲載誌、DOI、ページ、目印）のコピー
- コンテナで実行するための Dockerfile と、Unix ソケットでの待ち受け

[Unreleased]: https://github.com/sakashita44/pdf-deeplink/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sakashita44/pdf-deeplink/releases/tag/v0.1.0
