import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from './config.ts';

const P = 'PDF_DEEPLINK_ZOTERO_';
const absolute = path.resolve('/zotero/storage');
const other = path.resolve('/zotero/linked');
const webdav = {
    [`${P}FILE_SOURCE`]: 'webdav',
    [`${P}WEBDAV_URL`]: 'https://dav.example/dav',
};

test('loadConfig: FILE_SOURCE がなく FILE_PATH があれば、従来どおりテンプレートで取得する', () => {
    const config = loadConfig({ [`${P}FILE_PATH`]: '/files/{key}' });
    assert.deepEqual(config.zotero.file, {
        kind: 'template',
        path: '/files/{key}',
    });
    assert.equal(config.zotero.apiKey, undefined);
});

test('loadConfig: 取得方法を決められない設定、取得方法に合わない変数、不完全な設定は起動時に拒否する', () => {
    const cases: NodeJS.ProcessEnv[] = [
        {},
        { [`${P}FILE_SOURCE`]: 'path' },
        { [`${P}FILE_SOURCE`]: 'template' },
        { [`${P}FILE_PATH`]: '/files/' },
        {
            [`${P}FILE_SOURCE`]: 'local',
            [`${P}LOCAL_DIRS`]: absolute,
            [`${P}FILE_PATH`]: '/files/{key}',
        },
        { [`${P}FILE_SOURCE`]: 'web', [`${P}WEBDAV_URL`]: 'https://dav' },
        { [`${P}FILE_SOURCE`]: 'local' },
        { [`${P}FILE_SOURCE`]: 'local', [`${P}LOCAL_DIRS`]: 'relative/dir' },
        {
            [`${P}FILE_SOURCE`]: 'local',
            [`${P}LOCAL_DIRS`]: `${absolute}${path.delimiter}`,
        },
        { [`${P}FILE_SOURCE`]: 'webdav' },
        { ...webdav, [`${P}WEBDAV_URL`]: 'ftp://dav.example/' },
        { ...webdav, [`${P}WEBDAV_URL`]: 'https://dav.example/?a=1' },
        { ...webdav, [`${P}WEBDAV_USERNAME`]: 'zotero' },
        { ...webdav, [`${P}WEBDAV_PASSWORD`]: 'pass' },
        {
            ...webdav,
            [`${P}WEBDAV_USERNAME`]: 'a:b',
            [`${P}WEBDAV_PASSWORD`]: 'pass',
        },
    ];
    for (const env of cases)
        assert.throws(() => loadConfig(env), Error, JSON.stringify(env));
});

test('loadConfig: 取得方法ごとの設定を読む', () => {
    assert.deepEqual(
        loadConfig({
            [`${P}FILE_SOURCE`]: 'local',
            [`${P}LOCAL_DIRS`]: `${absolute}${path.delimiter}${other}`,
        }).zotero.file,
        { kind: 'local', dirs: [absolute, other] },
    );
    const dav = loadConfig({
        ...webdav,
        [`${P}WEBDAV_USERNAME`]: 'zotero',
        [`${P}WEBDAV_PASSWORD`]: ' pass ',
    }).zotero.file;
    assert.equal(dav.kind, 'webdav');
    if (dav.kind === 'webdav')
        assert.deepEqual(dav.credentials, {
            username: 'zotero',
            password: ' pass ',
        });
    const web = loadConfig({
        [`${P}FILE_SOURCE`]: 'web',
        [`${P}ENDPOINT`]: 'https://api.zotero.org',
        [`${P}API_KEY`]: 'k',
    }).zotero;
    assert.deepEqual(web.file, { kind: 'web' });
    assert.deepEqual(web.endpoint, {
        protocol: 'https:',
        host: 'api.zotero.org',
        port: 443,
    });
    assert.equal(web.apiKey, 'k');
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

test('loadConfig: 資格情報は環境変数かファイルのどちらか一方から読み、ファイルは末尾の改行だけを除く', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pdf-deeplink-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = (name: string, content: string) => {
        const filePath = path.join(dir, name);
        writeFileSync(filePath, content);
        return filePath;
    };
    const template = { [`${P}FILE_PATH`]: '/files/{key}' };
    const keyFile = file('key', '﻿ key \r\n');
    assert.equal(
        loadConfig({ ...template, [`${P}API_KEY_FILE`]: keyFile }).zotero
            .apiKey,
        ' key ',
    );
    const dav = loadConfig({
        ...webdav,
        [`${P}WEBDAV_USERNAME`]: 'zotero',
        [`${P}WEBDAV_PASSWORD_FILE`]: file('password', 'secret\n'),
    }).zotero.file;
    assert.ok(dav.kind === 'webdav' && dav.credentials?.password === 'secret');

    for (const env of [
        { [`${P}API_KEY`]: 'k', [`${P}API_KEY_FILE`]: keyFile },
        { [`${P}API_KEY_FILE`]: file('lines', 'a\nb\n') },
        { [`${P}API_KEY_FILE`]: file('empty', '\n') },
        { [`${P}API_KEY_FILE`]: path.join(dir, 'missing') },
        { [`${P}API_KEY`]: '' },
    ])
        assert.throws(
            () => loadConfig({ ...template, ...env }),
            Error,
            JSON.stringify(env),
        );
});
