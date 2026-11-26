// PDF.js の PDFFindController が検索の前にページの文字列へ施す改行の扱い（pdf_viewer.mjs の normalize()）に合わせる。分岐の順序も同じにする。結合用の濁点・半濁点の直後の改行と、結合文字の直後の行末のハイフンと改行は除く。英字の語を分けた行末のハイフンは改行とともに除き、それ以外の行末のハイフンは残す。漢字とかなの直後の改行は空白にせず除く。
const LINE_BREAK =
    /([\u3099\u309A])\n|(\p{M}+)-\n|(\p{Ll})-\n(?=\p{Ll})|(\p{Lu})-\n(?=\p{L})|(\S-)\n|(\p{Ideographic}|[\u3040-\u30FF])\n|\n/gu;

export function normalizeQuote(text: string): string {
    return text
        .replace(
            LINE_BREAK,
            (_match, ...groups: (string | undefined)[]) =>
                groups.slice(0, 6).find((group) => group !== undefined) ?? ' ',
        )
        .replace(/\s+/g, ' ')
        .trim();
}
