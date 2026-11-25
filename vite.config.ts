import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const PDFJS_ROOT = resolve('node_modules/pdfjs-dist');
const PDFJS_ASSETS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

// PDF.js は CMap、標準フォント、Wasm、ICC プロファイルを import せず、getDocument() に渡した URL から実行時に取得するため、バンドルせずに /pdfjs/ で配信する。
function pdfjsAssets(): Plugin {
    let outDir = '';
    return {
        name: 'pdfjs-assets',
        configResolved(config) {
            outDir = resolve(config.root, config.build.outDir);
        },
        configureServer(server) {
            server.middlewares.use('/pdfjs/', (req, res, next) => {
                const relative = normalize(decodeURIComponent((req.url ?? '').split('?')[0] ?? ''));
                const file = join(PDFJS_ROOT, relative);
                const allowed = PDFJS_ASSETS.some((dir) => file.startsWith(join(PDFJS_ROOT, dir) + sep));
                if (!allowed || !existsSync(file) || !statSync(file).isFile()) return next();
                createReadStream(file).pipe(res);
            });
        },
        closeBundle() {
            for (const dir of PDFJS_ASSETS) {
                cpSync(join(PDFJS_ROOT, dir), join(outDir, 'pdfjs', dir), { recursive: true });
            }
        },
    };
}

export default defineConfig({
    root: 'web',
    appType: 'spa',
    plugins: [pdfjsAssets()],
    build: { outDir: '../dist', emptyOutDir: true },
    server: {
        host: '127.0.0.1',
        port: 5173,
        strictPort: true,
        proxy: { '/app': `http://${process.env.PDF_DEEPLINK_LISTEN ?? '127.0.0.1:8787'}` },
    },
});
