const { expect } = require('chai');
const sinon = require('sinon');

const RemoteAuth = require('../../src/authStrategies/RemoteAuth');

function createAuth({ sessionExists = true } = {}) {
    const store = {
        sessionExists: sinon.stub().resolves(sessionExists),
        save: sinon.stub().resolves(),
        extract: sinon.stub().resolves(),
        delete: sinon.stub().resolves(),
    };
    const auth = new RemoteAuth({
        store,
        clientId: 'unit',
        backupSyncIntervalMs: 60000,
    });
    auth.setup({ emit: sinon.spy(), options: { puppeteer: {} } });
    auth.sessionName = 'RemoteAuth-unit';
    auth.userDataDir = '/nonexistent/RemoteAuth-unit';
    return auth;
}

describe('RemoteAuth', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('keeps a single backup timer when ready fires again', async function () {
        const clock = sinon.useFakeTimers();
        const auth = createAuth();
        const backup = sinon.stub(auth, 'storeRemoteSession').resolves();

        // WhatsApp Web reloading emits `ready` once more
        await auth.afterAuthReady();
        await auth.afterAuthReady();
        await clock.tickAsync(60000);

        expect(backup.callCount).to.equal(1);
        await auth.destroy();
    });

    it('keeps backing up when the first save fails', async function () {
        const clock = sinon.useFakeTimers();
        const auth = createAuth();
        auth.store.sessionExists.rejects(new Error('store is down'));
        const backup = sinon.stub(auth, 'storeRemoteSession').resolves();

        await auth.afterAuthReady().catch(() => {});
        await clock.tickAsync(60000);

        expect(backup.callCount).to.equal(1);
        await auth.destroy();
    });

    it('logs a failed periodic backup instead of crashing', async function () {
        const clock = sinon.useFakeTimers();
        const auth = createAuth();
        sinon.stub(auth, 'storeRemoteSession').rejects(new Error('disk full'));
        const log = sinon.stub(console, 'error');

        await auth.afterAuthReady();
        await clock.tickAsync(60000);

        expect(log.calledOnce).to.equal(true);
        clearInterval(auth.backupSync);
    });

    it('does not run overlapping backups', async function () {
        const auth = createAuth();
        let finish;
        const save = sinon.stub(auth, 'compressAndSaveSession').returns(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );

        const first = auth.storeRemoteSession();
        const second = auth.storeRemoteSession();
        finish();
        await Promise.all([first, second]);

        expect(save.calledOnce).to.equal(true);
    });

    it('backs up once more when destroyed after being ready', async function () {
        const auth = createAuth();
        await auth.afterAuthReady();
        const backup = sinon.stub(auth, 'storeRemoteSession').resolves();

        await auth.destroy();

        expect(backup.calledOnce).to.equal(true);
    });

    it('does not back up a session that never got ready', async function () {
        const auth = createAuth();
        const backup = sinon.stub(auth, 'storeRemoteSession').resolves();

        await auth.destroy();

        expect(backup.called).to.equal(false);
    });

    it('does not back up a wiped session on destroy', async function () {
        const auth = createAuth();
        await auth.afterAuthReady();
        const backup = sinon.stub(auth, 'storeRemoteSession').resolves();

        await auth.disconnect();
        await auth.destroy();

        expect(backup.called).to.equal(false);
    });

    it('does not start the timer after being destroyed during the first save delay', async function () {
        const clock = sinon.useFakeTimers();
        const auth = createAuth({ sessionExists: false });
        const backup = sinon.stub(auth, 'storeRemoteSession').resolves();

        const ready = auth.afterAuthReady();
        await clock.tickAsync(1000);
        await auth.destroy();
        await clock.tickAsync(59000);
        await ready;
        const callsAfterDestroy = backup.callCount;
        await clock.tickAsync(120000);

        expect(backup.callCount).to.equal(callsAfterDestroy);
    });
});
