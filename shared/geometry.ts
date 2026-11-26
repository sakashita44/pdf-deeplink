import { roundCoordinate, type Rect } from './link.ts';

export type Point = readonly [x: number, y: number];
export type ViewBox = readonly [x1: number, y1: number, x2: number, y2: number];

export interface PageGeometry {
    viewBox: ViewBox;
    rotation: number;
}

// PDF のユーザー空間（左下原点、y 軸は上向き）と、/Rotate（時計回り）と CropBox を適用した表示上のページ（左上原点、y 軸は下向き）を相互に変換する。式は PDF.js の PageViewport と同じ。
export function userToDisplay(page: PageGeometry, [x, y]: Point): Point {
    const [x1, y1, x2, y2] = page.viewBox;
    switch (normalizeRotation(page.rotation)) {
        case 90:
            return [y - y1, x - x1];
        case 180:
            return [x2 - x, y - y1];
        case 270:
            return [y2 - y, x2 - x];
        default:
            return [x - x1, y2 - y];
    }
}

export function displayToUser(page: PageGeometry, [dx, dy]: Point): Point {
    const [x1, y1, x2, y2] = page.viewBox;
    switch (normalizeRotation(page.rotation)) {
        case 90:
            return [dy + x1, dx + y1];
        case 180:
            return [x2 - dx, dy + y1];
        case 270:
            return [x2 - dy, y2 - dx];
        default:
            return [dx + x1, y2 - dy];
    }
}

export function toLinkRect(page: PageGeometry, a: Point, b: Point): Rect {
    const [ax, ay] = userToDisplay(page, a);
    const [bx, by] = userToDisplay(page, b);
    return [
        Math.min(ax, bx),
        Math.min(ay, by),
        Math.abs(ax - bx),
        Math.abs(ay - by),
    ];
}

export function toUserSpace(
    page: PageGeometry,
    [x, y, w, h]: Rect,
): [number, number, number, number] {
    const [ax, ay] = displayToUser(page, [x, y]);
    const [bx, by] = displayToUser(page, [x + w, y + h]);
    return [
        Math.min(ax, bx),
        Math.min(ay, by),
        Math.max(ax, bx),
        Math.max(ay, by),
    ];
}

export function mergeLineRects(rects: Rect[]): Rect[] {
    const lines: { seed: Rect; bounds: Rect; rects: Rect[] }[] = [];
    for (const rect of [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
        const line = lines.find((candidate) => sameLine(candidate.seed, rect));
        if (line) {
            line.rects.push(rect);
            line.bounds = union(line.bounds, rect);
        } else {
            lines.push({ seed: rect, bounds: rect, rects: [rect] });
        }
    }
    const merged: Rect[] = [];
    for (const line of lines.sort((a, b) => a.bounds[1] - b.bounds[1])) {
        let current: Rect | null = null;
        // 0.6 は、語間の空白を結合し、段組の列間は分けるための経験的な閾値で、実測による検証はしていない。
        for (const rect of line.rects.sort((a, b) => a[0] - b[0])) {
            if (
                current &&
                rect[0] - (current[0] + current[2]) <=
                    Math.min(current[3], rect[3]) * 0.6
            ) {
                current = union(current, rect);
            } else {
                if (current) merged.push(current);
                current = rect;
            }
        }
        if (current) merged.push(current);
    }
    return merged
        .map((rect) => rect.map(roundCoordinate) as unknown as Rect)
        .filter(([, , w, h]) => w > 0 && h > 0);
}

export function mergeSelectionRects(rects: Rect[]): Rect[] {
    const columns: { lines: Rect[]; bounds: Rect }[] = [];
    for (const line of mergeLineRects(rects)) {
        const column = columns.find((candidate) => sameColumn(candidate, line));
        if (column) {
            column.lines.push(line);
            column.bounds = union(column.bounds, line);
        } else {
            columns.push({ lines: [line], bounds: line });
        }
    }
    const firstIndex = (bounds: Rect) => {
        const index = rects.findIndex((rect) =>
            contains(bounds, [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2]),
        );
        return index === -1 ? rects.length : index;
    };
    return columns
        .map((column) => ({ ...column, order: firstIndex(column.bounds) }))
        .sort((a, b) => a.order - b.order)
        .flatMap(({ lines }) =>
            lines.length <= 2
                ? lines
                : [lines[0]!, lines.slice(1, -1).reduce(union), lines.at(-1)!],
        )
        .map((rect) => rect.map(roundCoordinate) as unknown as Rect);
}

// 横方向に狭いほうの幅の半分以上が重なり、行間が行の高さの 1.5 倍以内であれば、同じ段組の続きの行とみなす。2 行目以降は、それまでの行の左右端から行の高さを超えてはみ出す行を、全幅の見出しや脚注として別の段組に分ける。経験的な閾値で、実測による検証はしていない。
function sameColumn(
    column: { lines: Rect[]; bounds: Rect },
    below: Rect,
): boolean {
    const above = column.lines.at(-1)!;
    const overlap =
        Math.min(above[0] + above[2], below[0] + below[2]) -
        Math.max(above[0], below[0]);
    const gap = below[1] - (above[1] + above[3]);
    const height = Math.max(above[3], below[3]);
    if (
        overlap < Math.min(above[2], below[2]) * 0.5 ||
        gap < -Math.min(above[3], below[3]) * 0.5 ||
        gap > height * 1.5
    )
        return false;
    if (column.lines.length < 2) return true;
    const [left, , width] = column.bounds;
    return (
        below[0] >= left - height &&
        below[0] + below[2] <= left + width + height
    );
}

function contains([x, y, w, h]: Rect, [px, py]: Point): boolean {
    return px >= x && px <= x + w && py >= y && py <= y + h;
}

function union(a: Rect, b: Rect): Rect {
    const left = Math.min(a[0], b[0]);
    const top = Math.min(a[1], b[1]);
    return [
        left,
        top,
        Math.max(a[0] + a[2], b[0] + b[2]) - left,
        Math.max(a[1] + a[3], b[1] + b[3]) - top,
    ];
}

function normalizeRotation(rotation: number): number {
    return ((rotation % 360) + 360) % 360;
}

// PDF.js のテキストレイヤーでは、同じ行の文字でもフォントや上付き文字によって矩形の上下がずれる。高さの半分以上が重なれば同じ行とみなす経験的な閾値で、実測による検証はしていない。
function sameLine(a: Rect, b: Rect): boolean {
    const overlap = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
    return overlap >= Math.min(a[3], b[3]) * 0.5;
}
