// PDF.js の PDFFindController が検索の前にページの文字列へ施す改行の扱い（pdf_viewer.mjs の normalize()）に合わせる。英字の語を分けた行末のハイフンは改行とともに除き、それ以外の行末のハイフンは残す。漢字とかなの直後の改行は空白にせず除く。
const LINE_BREAK =
    /(\p{Ll})-\n(?=\p{Ll})|(\p{Lu})-\n(?=\p{L})|(\S-)\n|(\p{Ideographic}|[\u3040-\u30FF])\n|\n/gu;

export function normalizeQuote(text: string): string {
    return text
        .replace(
            LINE_BREAK,
            (
                _match,
                lower?: string,
                upper?: string,
                hyphen?: string,
                cjk?: string,
            ) => lower ?? upper ?? hyphen ?? cjk ?? ' ',
        )
        .replace(/\s+/g, ' ')
        .trim();
}
