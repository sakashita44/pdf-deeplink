import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from './config.ts';

const P = 'PDF_DEEPLINK_ZOTERO_';
const absolute = path.resolve('/zotero/storage');
const webdav = {
    [`${P}FILE_SOURCE`]: 'webdav',
    [`${P}WEBDAV_URL`]: 'https://dav.example/dav',
};

test('loadConfig: FILE_SOURCE を指定せず FILE_PATH を指定した場合は、経路のテンプレートで取得する', () => {
    const config = loadConfig({ [`${P}FILE_PATH`]: '/files/{key}' });
    assert.deepEqual(config.zotero.file, {
        kind: 'template',
        path: '/files/{key}',
    });
});

test('loadConfig: LOCAL_DIRS の空の要素と相対パスは、読める範囲を広げないよう拒否する', () => {
    for (const dirs of ['relative/dir', `${absolute}${path.delimiter}`])
        assert.throws(
            () =>
                loadConfig({
                    [`${P}FILE_SOURCE`]: 'local',
                    [`${P}LOCAL_DIRS`]: dirs,
                }),
            Error,
            dirs,
        );
});

test('loadConfig: 資格情報を含む WebDAV の URL は、値をエラーに出さずに拒否する', () => {
    assert.throws(
        () =>
            loadConfig({
                ...webdav,
                [`${P}WEBDAV_URL`]: 'https://user:hunter2@dav.example/',
            }),
        (error: Error) => !error.message.includes('hunter2'),
    );
});

test('loadConfig: 資格情報をファイルから読み、末尾の改行だけを除く', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pdf-deeplink-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = (name: string, content: string) => {
        const filePath = path.join(dir, name);
        writeFileSync(filePath, content);
        return filePath;
    };
    assert.equal(
        loadConfig({
            [`${P}FILE_PATH`]: '/files/{key}',
            [`${P}API_KEY_FILE`]: file('key', '\u{FEFF} key \r\n'),
        }).zotero.apiKey,
        ' key ',
    );
    const dav = loadConfig({
        ...webdav,
        [`${P}WEBDAV_USERNAME`]: 'zotero',
        [`${P}WEBDAV_PASSWORD_FILE`]: file('password', 'secret\n'),
    }).zotero.file;
    assert.ok(dav.kind === 'webdav' && dav.credentials?.password === 'secret');
});
