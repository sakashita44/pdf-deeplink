import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseDirs, secret } from './config.ts';

const P = 'PDF_DEEPLINK_ZOTERO_';
const absolute = path.resolve('/zotero/storage');

test('loadConfig: FILE_SOURCE がなく FILE_PATH があれば、従来どおりテンプレートで取得する', () => {
    const config = loadConfig({ [`${P}FILE_PATH`]: '/files/{key}' });
    assert.deepEqual(config.zotero.file, {
        kind: 'template',
        path: '/files/{key}',
    });
    assert.equal(config.zotero.apiKey, undefined);
});

test('loadConfig: 取得方法を決められない設定と、取得方法に合わない変数は起動時に拒否する', () => {
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
        { [`${P}FILE_SOURCE`]: 'webdav' },
    ];
    for (const env of cases)
        assert.throws(() => loadConfig(env), Error, JSON.stringify(env));
});

test('loadConfig: 取得方法ごとの設定を読む', () => {
    assert.deepEqual(
        loadConfig({
            [`${P}FILE_SOURCE`]: 'local',
            [`${P}LOCAL_DIRS`]: absolute,
        }).zotero.file,
        { kind: 'local', dirs: [absolute] },
    );
    const webdav = loadConfig({
        [`${P}FILE_SOURCE`]: 'webdav',
        [`${P}WEBDAV_URL`]: 'https://dav.example/dav',
        [`${P}WEBDAV_USERNAME`]: 'zotero',
        [`${P}WEBDAV_PASSWORD`]: ' pass ',
    }).zotero.file;
    assert.equal(webdav.kind, 'webdav');
    if (webdav.kind === 'webdav')
        assert.deepEqual(webdav.credentials, {
            username: 'zotero',
            password: ' pass ',
        });
    const web = loadConfig({
        [`${P}FILE_SOURCE`]: 'web',
        [`${P}ENDPOINT`]: 'https://api.zotero.org',
        [`${P}API_KEY`]: 'k',
    }).zotero;
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
                [`${P}FILE_SOURCE`]: 'webdav',
                [`${P}WEBDAV_URL`]: 'https://user:hunter2@dav.example/',
            }),
        (error: Error) => !error.message.includes('hunter2'),
    );
    assert.throws(() =>
        loadConfig({
            [`${P}FILE_SOURCE`]: 'webdav',
            [`${P}WEBDAV_URL`]: 'https://dav.example/',
            [`${P}WEBDAV_USERNAME`]: 'zotero',
        }),
    );
});

test('secret: 環境変数かファイルのどちらか一方から読み、ファイルは末尾の改行だけを除く', () => {
    const files: Record<string, string> = {
        crlf: '﻿ key \r\n',
        twoLines: 'a\nb\n',
        empty: '\n',
    };
    const read = (file: string) => files[file]!;
    assert.equal(
        secret({ [`${P}API_KEY_FILE`]: 'crlf' }, 'API_KEY', read),
        ' key ',
    );
    assert.equal(secret({ [`${P}API_KEY`]: 'k' }, 'API_KEY', read), 'k');
    assert.equal(secret({}, 'API_KEY', read), undefined);
    for (const env of [
        { [`${P}API_KEY`]: 'k', [`${P}API_KEY_FILE`]: 'crlf' },
        { [`${P}API_KEY_FILE`]: 'twoLines' },
        { [`${P}API_KEY_FILE`]: 'empty' },
        { [`${P}API_KEY`]: '' },
    ])
        assert.throws(
            () => secret(env, 'API_KEY', read),
            Error,
            JSON.stringify(env),
        );
    assert.throws(
        () =>
            secret({ [`${P}API_KEY_FILE`]: 'missing' }, 'API_KEY', () => {
                throw new Error('ENOENT');
            }),
        /cannot read/,
    );
});

test('parseDirs: パス区切りで分け、空の要素と相対パスを拒否する', () => {
    const other = path.resolve('/other');
    assert.deepEqual(parseDirs(`${absolute}${path.delimiter}${other}`), [
        absolute,
        other,
    ]);
    assert.throws(() => parseDirs(`${absolute}${path.delimiter}`));
    assert.throws(() => parseDirs('relative/dir'));
    assert.throws(() => parseDirs(undefined));
});
