'use strict';

const path = require('path');
const Crypto = require('crypto');
const { tmpdir } = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const ffmpeg = require('fluent-ffmpeg');
const webp = require('node-webpmux');
const fs = require('fs').promises;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const execFileAsync = promisify(execFile);

/**
 * Utility methods
 */
class Util {
    constructor() {
        throw new Error(
            `The ${this.constructor.name} class may not be instantiated.`,
        );
    }

    static generateHash(length) {
        var result = '';
        var characters =
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        var charactersLength = characters.length;
        for (var i = 0; i < length; i++) {
            result += characters.charAt(
                Math.floor(Math.random() * charactersLength),
            );
        }
        return result;
    }

    /**
     * Sets default properties on an object that aren't already specified.
     * @param {Object} def Default properties
     * @param {Object} given Object to assign defaults to
     * @returns {Object}
     * @private
     */
    static mergeDefault(def, given) {
        if (!given) return def;
        for (const key in def) {
            if (!has(given, key) || given[key] === undefined) {
                given[key] = def[key];
            } else if (given[key] === Object(given[key])) {
                given[key] = Util.mergeDefault(def[key], given[key]);
            }
        }

        return given;
    }

    /**
     * Formats a image to webp
     * @param {MessageMedia} media
     *
     * @returns {Promise<MessageMedia>} media in webp format
     */
    static async formatImageToWebpSticker(media, pupPage) {
        if (!media.mimetype.includes('image'))
            throw new Error('media is not a image');

        if (media.mimetype.includes('webp')) {
            return media;
        }

        return pupPage.evaluate((media) => {
            return window.WWebJS.toStickerData(media);
        }, media);
    }

    /**
     * Formats a video to webp
     * @param {MessageMedia} media
     *
     * @returns {Promise<MessageMedia>} media in webp format
     */
    static async formatVideoToWebpSticker(media) {
        if (!media.mimetype.includes('video'))
            throw new Error('media is not a video');

        const videoType = media.mimetype.split('/')[1];

        const tempFile = path.join(
            tmpdir(),
            `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`,
        );

        const stream = new (require('stream').Readable)();
        const buffer = Buffer.from(
            media.data.replace(`data:${media.mimetype};base64,`, ''),
            'base64',
        );
        stream.push(buffer);
        stream.push(null);

        await new Promise((resolve, reject) => {
            ffmpeg(stream)
                .inputFormat(videoType)
                .on('error', reject)
                .on('end', () => resolve(true))
                .addOutputOptions([
                    '-vcodec',
                    'libwebp',
                    '-vf',
                    // eslint-disable-next-line no-useless-escape
                    "scale='iw*min(300/iw\,300/ih)':'ih*min(300/iw\,300/ih)',format=rgba,pad=300:300:'(300-iw)/2':'(300-ih)/2':'#00000000',setsar=1,fps=10",
                    '-loop',
                    '0',
                    '-ss',
                    '00:00:00.0',
                    '-t',
                    '00:00:05.0',
                    '-preset',
                    'default',
                    '-an',
                    '-vsync',
                    '0',
                    '-s',
                    '512:512',
                ])
                .toFormat('webp')
                .save(tempFile);
        });

        const data = await fs.readFile(tempFile, 'base64');
        await fs.unlink(tempFile);

        return {
            mimetype: 'image/webp',
            data: data,
            filename: media.filename,
        };
    }

    /**
     * Sticker metadata.
     * @typedef {Object} StickerMetadata
     * @property {string} [name]
     * @property {string} [author]
     * @property {string[]} [categories]
     */

    /**
     * Formats a media to webp
     * @param {MessageMedia} media
     * @param {StickerMetadata} metadata
     *
     * @returns {Promise<MessageMedia>} media in webp format
     */
    static async formatToWebpSticker(media, metadata, pupPage) {
        let webpMedia;

        if (media.mimetype.includes('image'))
            webpMedia = await this.formatImageToWebpSticker(media, pupPage);
        else if (media.mimetype.includes('video'))
            webpMedia = await this.formatVideoToWebpSticker(media);
        else throw new Error('Invalid media format');

        if (metadata.name || metadata.author) {
            const img = new webp.Image();
            const hash = this.generateHash(32);
            const stickerPackId = hash;
            const packname = metadata.name;
            const author = metadata.author;
            const categories = metadata.categories || [''];
            const json = {
                'sticker-pack-id': stickerPackId,
                'sticker-pack-name': packname,
                'sticker-pack-publisher': author,
                emojis: categories,
            };
            let exifAttr = Buffer.from([
                0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
                0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00,
                0x00, 0x00,
            ]);
            let jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
            let exif = Buffer.concat([exifAttr, jsonBuffer]);
            exif.writeUIntLE(jsonBuffer.length, 14, 4);
            await img.load(Buffer.from(webpMedia.data, 'base64'));
            img.exif = exif;
            webpMedia.data = (await img.save(null)).toString('base64');
        }

        return webpMedia;
    }

    /**
     * Configure ffmpeg path
     * @param {string} path
     */
    static setFfmpegPath(path) {
        ffmpeg.setFfmpegPath(path);
    }

    /**
     * Extracts the major version from a Chrome version string, e.g. "HeadlessChrome/146.0.7680.31"
     * @param {string} text
     * @returns {?number}
     */
    static parseChromeMajorVersion(text) {
        const match = /(\d{1,4})\.\d{1,4}\.\d{1,6}\.\d{1,6}/.exec(text || '');
        return match ? Number(match[1]) : null;
    }

    /**
     * Gets the major version of a Chrome executable without launching a browser window
     * @param {string} executablePath
     * @returns {Promise<?number>}
     */
    static async getChromeMajorVersion(executablePath) {
        if (!executablePath) return null;

        // Browsers downloaded by Puppeteer live in a directory named after their version
        const cacheDir = /[-_](\d{1,4}\.\d{1,4}\.\d{1,6}\.\d{1,6})[\\/]/.exec(
            executablePath,
        );
        if (cacheDir) return Util.parseChromeMajorVersion(cacheDir[1]);

        // On Windows `chrome.exe --version` opens a window instead of printing
        if (process.platform === 'win32') return null;

        try {
            const { stdout } = await execFileAsync(
                executablePath,
                ['--version'],
                { timeout: 5000 },
            );
            return Util.parseChromeMajorVersion(stdout);
        } catch (ignoredError) {
            // Unknown version: the caller reads it from the running browser instead
            return null;
        }
    }

    /**
     * Builds the user agent that a regular (non-headless) Chrome of the given version sends on this platform
     * @param {number} majorVersion
     * @returns {string}
     */
    static buildUserAgent(majorVersion) {
        const platforms = {
            darwin: 'Macintosh; Intel Mac OS X 10_15_7',
            win32: 'Windows NT 10.0; Win64; x64',
        };
        const platform = platforms[process.platform] || 'X11; Linux x86_64';

        return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
    }
}

module.exports = Util;
