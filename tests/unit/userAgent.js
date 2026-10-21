const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const Util = require('../../src/util/Util');

describe('User agent helpers', function () {
    it('parses the major version out of a browser version', function () {
        expect(
            Util.parseChromeMajorVersion('HeadlessChrome/146.0.7680.31'),
        ).to.equal(146);
        expect(Util.parseChromeMajorVersion('Chrome/99.0.4844.51')).to.equal(
            99,
        );
        expect(Util.parseChromeMajorVersion('not a version')).to.equal(null);
    });

    it('reads the version from a browser downloaded by Puppeteer', async function () {
        expect(
            await Util.getChromeMajorVersion(
                '/home/me/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome',
            ),
        ).to.equal(146);
        expect(
            await Util.getChromeMajorVersion(
                'C:\\Users\\me\\.cache\\puppeteer\\chrome\\win64-146.0.7680.31\\chrome-win64\\chrome.exe',
            ),
        ).to.equal(146);
    });

    it('asks other executables for their version', async function () {
        if (process.platform === 'win32') this.skip();

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-ua-'));
        const executable = path.join(dir, 'chromium');
        fs.writeFileSync(
            executable,
            '#!/bin/sh\necho "Chromium 141.0.7390.54 snap"\n',
        );
        fs.chmodSync(executable, 0o755);

        try {
            expect(await Util.getChromeMajorVersion(executable)).to.equal(141);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('returns null when the version cannot be found', async function () {
        expect(await Util.getChromeMajorVersion(undefined)).to.equal(null);
        expect(
            await Util.getChromeMajorVersion('/nonexistent/chrome'),
        ).to.equal(null);
    });

    it('builds the user agent of a regular Chrome', function () {
        const userAgent = Util.buildUserAgent(146);

        expect(userAgent).to.match(
            /^Mozilla\/5\.0 \([^)]+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/146\.0\.0\.0 Safari\/537\.36$/,
        );
        expect(userAgent).to.not.include('Headless');
    });
});
