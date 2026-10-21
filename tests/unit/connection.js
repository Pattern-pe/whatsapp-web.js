const EventEmitter = require('events');
const { expect } = require('chai');
const sinon = require('sinon');

const Client = require('../../src/Client');
const {
    Events,
    WAState,
    DisconnectReason,
} = require('../../src/util/Constants');

// Stand-ins for the Puppeteer objects, so no browser is launched
function fakeBrowser() {
    const browser = new EventEmitter();
    browser.connected = true;
    browser.isConnected = () => browser.connected;
    browser.close = sinon.spy(async () => {
        browser.connected = false;
        browser.emit('disconnected');
    });
    return browser;
}

function fakePage() {
    const page = new EventEmitter();
    page.evaluate = sinon.stub().resolves();
    return page;
}

function createClient(options) {
    const client = new Client(options);
    client.pupBrowser = fakeBrowser();
    client.pupPage = fakePage();
    sinon.spy(client.authStrategy, 'disconnect');
    sinon.spy(client.authStrategy, 'destroy');
    return client;
}

function recordDisconnects(client) {
    const reasons = [];
    client.on(Events.DISCONNECTED, (reason) => reasons.push(reason));
    return reasons;
}

describe('Client connection handling', function () {
    afterEach(function () {
        sinon.restore();
    });

    describe('connection states', function () {
        it('keeps running in working states', async function () {
            const client = createClient();
            const reasons = recordDisconnects(client);

            for (const state of [
                WAState.CONNECTED,
                WAState.OPENING,
                WAState.PAIRING,
                WAState.TIMEOUT,
            ]) {
                expect(await client._handleConnectionState(state)).to.equal(
                    false,
                );
            }

            expect(reasons).to.deep.equal([]);
            expect(client.pupBrowser.close.called).to.equal(false);
        });

        it('disconnects on blocking states without wiping the session', async function () {
            for (const state of [
                WAState.CONFLICT,
                WAState.TOS_BLOCK,
                WAState.SMB_TOS_BLOCK,
                WAState.PROXYBLOCK,
                WAState.DEPRECATED_VERSION,
                WAState.UNLAUNCHED,
            ]) {
                const client = createClient();
                const reasons = recordDisconnects(client);

                expect(await client._handleConnectionState(state)).to.equal(
                    true,
                );

                expect(reasons).to.deep.equal([state]);
                expect(client.pupBrowser.close.calledOnce).to.equal(true);
                expect(client.authStrategy.disconnect.called).to.equal(false);
            }
        });

        it('wipes the session only when the device was unpaired', async function () {
            const client = createClient();
            const reasons = recordDisconnects(client);

            await client._handleConnectionState(WAState.UNPAIRED);

            expect(reasons).to.deep.equal([WAState.UNPAIRED]);
            expect(client.authStrategy.disconnect.calledOnce).to.equal(true);
        });

        it('still disconnects if wiping the session fails', async function () {
            const client = createClient();
            const reasons = recordDisconnects(client);
            client.authStrategy.disconnect.restore();
            sinon
                .stub(client.authStrategy, 'disconnect')
                .rejects(new Error('store is down'));

            await client._handleConnectionState(WAState.UNPAIRED);

            expect(reasons).to.deep.equal([WAState.UNPAIRED]);
            expect(client.pupBrowser.close.calledOnce).to.equal(true);
        });

        it('takes over a conflict at most 3 times in 10 minutes', async function () {
            const clock = sinon.useFakeTimers();
            const client = createClient({ takeoverOnConflict: true });
            const reasons = recordDisconnects(client);

            for (let i = 0; i < 3; i++) {
                expect(
                    await client._handleConnectionState(WAState.CONFLICT),
                ).to.equal(false);
                clock.tick(1);
            }
            expect(client.pupPage.evaluate.callCount).to.equal(3);

            expect(
                await client._handleConnectionState(WAState.CONFLICT),
            ).to.equal(true);
            expect(reasons).to.deep.equal([WAState.CONFLICT]);
        });

        it('allows new takeovers once the window has passed', async function () {
            const clock = sinon.useFakeTimers();
            const client = createClient({ takeoverOnConflict: true });

            for (let i = 0; i < 3; i++) {
                await client._handleConnectionState(WAState.CONFLICT);
            }
            clock.tick(10 * 60 * 1000);

            expect(
                await client._handleConnectionState(WAState.CONFLICT),
            ).to.equal(false);
        });
    });

    describe('browser crashes', function () {
        it('reports a browser that went away, once', function () {
            const client = createClient();
            const reasons = recordDisconnects(client);
            client._watchBrowser(client.pupBrowser, client.pupPage);

            client.pupBrowser.connected = false;
            client.pupBrowser.emit('disconnected');
            client.pupPage.emit('close');

            expect(reasons).to.deep.equal([
                DisconnectReason.BROWSER_DISCONNECTED,
            ]);
        });

        it('reports a crashed page and closes its browser', async function () {
            const client = createClient();
            const reasons = recordDisconnects(client);
            client._watchBrowser(client.pupBrowser, client.pupPage);

            client.pupPage.emit('error', new Error('Page crashed!'));
            await client.destroy();

            expect(reasons).to.deep.equal([DisconnectReason.PAGE_CRASHED]);
            expect(client.pupBrowser.close.calledOnce).to.equal(true);
        });

        it('stays quiet when the client closes the browser itself', async function () {
            const client = createClient();
            const reasons = recordDisconnects(client);
            client._watchBrowser(client.pupBrowser, client.pupPage);

            await client.destroy();

            expect(reasons).to.deep.equal([]);
        });

        it('ignores a browser replaced by a later initialize', function () {
            const client = createClient();
            const reasons = recordDisconnects(client);
            const oldBrowser = client.pupBrowser;
            client._watchBrowser(oldBrowser, client.pupPage);

            client.pupBrowser = fakeBrowser();
            oldBrowser.emit('disconnected');

            expect(reasons).to.deep.equal([]);
        });
    });

    describe('destroy', function () {
        it('shares one teardown between concurrent calls', async function () {
            const client = createClient();

            await Promise.all([client.destroy(), client.destroy()]);

            expect(client.pupBrowser.close.calledOnce).to.equal(true);
            expect(client.authStrategy.destroy.calledOnce).to.equal(true);
        });

        it('does not report states that arrive while closing', async function () {
            const client = createClient();
            const reasons = recordDisconnects(client);

            const destroying = client.destroy();
            await client._handleConnectionState(WAState.CONFLICT);
            await destroying;

            expect(reasons).to.deep.equal([]);
        });

        it('makes a re-initialize from a disconnected listener wait for the teardown', async function () {
            const client = createClient();
            const order = [];
            const browser = client.pupBrowser;
            browser.close = async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                order.push('closed');
            };
            sinon
                .stub(client.authStrategy, 'beforeBrowserInitialized')
                .callsFake(async () => {
                    order.push('initialize');
                    throw new Error('stop before launching a browser');
                });

            let initializing;
            client.on(Events.DISCONNECTED, () => {
                initializing = client.initialize().catch(() => {});
            });

            await client._disconnect(WAState.CONFLICT);
            await initializing;

            expect(order).to.deep.equal(['closed', 'initialize']);
        });
    });

    describe('qr retries', function () {
        it('disconnects once qrMaxRetries is exceeded', async function () {
            const client = createClient({ qrMaxRetries: 2 });
            const reasons = recordDisconnects(client);
            client._qrRetries = 0;

            await client._countQrRetry();
            await client._countQrRetry();
            expect(reasons).to.deep.equal([]);

            await client._countQrRetry();
            expect(reasons).to.deep.equal([DisconnectReason.MAX_QR_RETRIES]);
        });

        it('never gives up when qrMaxRetries is 0', async function () {
            const client = createClient({ qrMaxRetries: 0 });
            const reasons = recordDisconnects(client);
            client._qrRetries = 0;

            for (let i = 0; i < 50; i++) await client._countQrRetry();

            expect(reasons).to.deep.equal([]);
        });
    });
});
