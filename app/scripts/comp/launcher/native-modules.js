import kdbxweb from 'kdbxweb';
import { Events } from 'framework/events';
import { Logger } from 'util/logger';
import { Launcher } from 'comp/launcher';
import { Timeouts } from 'const/timeouts';

let NativeModules;

if (Launcher) {
    const logger = new Logger('native-module-connector');

    let host;
    let callId = 0;
    let promises = {};
    let ykChalRespCallbacks = {};

    const handlers = {
        yubikeys(numYubiKeys) {
            Events.emit('native-modules-yubikeys', { numYubiKeys });
        },

        log(...args) {
            logger.info('Message from host', ...args);
        },

        result({ callId, result, error }) {
            const promise = promises[callId];
            if (promise) {
                delete promises[callId];
                if (error) {
                    logger.error('Received an error', promise.cmd, error);
                    promise.reject(error);
                } else {
                    promise.resolve(result);
                }
            }
        },

        'yk-chal-resp-result'({ callbackId, error, result }) {
            const callback = ykChalRespCallbacks[callbackId];
            if (callback) {
                const willBeCalledAgain = error && error.touchRequested;
                if (!willBeCalledAgain) {
                    delete ykChalRespCallbacks[callbackId];
                }
                callback(error, result);
            }
        }
    };

    NativeModules = {
        startHost() {
            if (host) {
                return;
            }

            logger.debug('Starting native module host');

            const path = Launcher.req('path');
            const appContentRoot = Launcher.remoteApp().getAppContentRoot();
            const mainModulePath = path.join(appContentRoot, 'native-module-host.js');

            const { fork } = Launcher.req('child_process');

            host = fork(mainModulePath);

            host.on('message', (message) => this.hostCallback(message));

            host.on('error', (e) => this.hostError(e));
            host.on('exit', (code, sig) => this.hostExit(code, sig));

            if (this.usbListenerRunning) {
                this.call('start-usb');
            }
        },

        hostError(e) {
            logger.error('Host error', e);
        },

        hostExit(code, sig) {
            logger.error(`Host exited with code ${code} and signal ${sig}`);
            host = null;

            const err = new Error('Native module host crashed');

            for (const promise of Object.values(promises)) {
                promise.reject(err);
            }
            promises = {};

            for (const callback of Object.values(ykChalRespCallbacks)) {
                callback(err);
            }
            ykChalRespCallbacks = {};

            if (code !== 0) {
                this.autoRestartHost();
            }
        },

        hostCallback(message) {
            const { cmd, args } = message;
            // logger.debug('Callback', cmd, args);
            if (handlers[cmd]) {
                handlers[cmd](...args);
            } else {
                logger.error('No callback', cmd);
            }
        },

        autoRestartHost() {
            setTimeout(() => {
                try {
                    this.startHost();
                } catch (e) {
                    logger.error('Native module host failed to auto-restart', e);
                }
            }, Timeouts.NativeModuleHostRestartTime);
        },

        call(cmd, ...args) {
            return new Promise((resolve, reject) => {
                if (!host) {
                    try {
                        this.startHost();
                    } catch (e) {
                        return reject(e);
                    }
                }

                callId++;
                if (callId === Number.MAX_SAFE_INTEGER) {
                    callId = 1;
                }
                // logger.debug('Call', cmd, args, callId);
                promises[callId] = { cmd, resolve, reject };
                host.send({ cmd, args, callId });
            });
        },

        makeXoredValue(val) {
            const data = Buffer.from(val);
            const random = Buffer.from(kdbxweb.Random.getBytes(data.length));

            for (let i = 0; i < data.length; i++) {
                data[i] ^= random[i];
            }

            const result = { data: [...data], random: [...random] };

            data.fill(0);
            random.fill(0);

            return result;
        },

        readXoredValue(val) {
            const data = Buffer.from(val.data);
            const random = Buffer.from(val.random);

            for (let i = 0; i < data.length; i++) {
                data[i] ^= random[i];
            }

            val.data.fill(0);
            val.random.fill(0);

            return data;
        },

        startUsbListener() {
            this.call('start-usb');
            this.usbListenerRunning = true;
        },

        stopUsbListener() {
            this.usbListenerRunning = false;
            if (host) {
                this.call('stop-usb');
            }
        },

        getYubiKeys(config) {
            return this.call('get-yubikeys', config);
        },

        yubiKeyChallengeResponse(yubiKey, challenge, slot, callback) {
            ykChalRespCallbacks[callId] = callback;
            return this.call('yk-chal-resp', yubiKey, challenge, slot, callId);
        },

        yubiKeyCancelChallengeResponse() {
            if (host) {
                this.call('yk-cancel-chal-resp');
            }
        },

        argon2(password, salt, options) {
            return this.call('argon2', password, salt, options);
        },

        hardwareEncrypt: async (value) => {
            const { ipcRenderer } = Launcher.electron();
            value = NativeModules.makeXoredValue(value);
            const encrypted = await ipcRenderer.invoke('hardware-encrypt', value);
            return NativeModules.readXoredValue(encrypted);
        },

        hardwareDecrypt: async (value, touchIdPrompt) => {
            const { ipcRenderer } = Launcher.electron();
            value = NativeModules.makeXoredValue(value);
            const decrypted = await ipcRenderer.invoke('hardware-decrypt', value, touchIdPrompt);
            return NativeModules.readXoredValue(decrypted);
        },

        kbdGetActiveWindow(options) {
            return this.call('kbd-get-active-window', options);
        },

        kbdGetActivePid() {
            return this.call('kbd-get-active-pid');
        },

        kbdShowWindow(win) {
            return this.call('kbd-show-window', win);
        },

        kbdText(str) {
            return this.call('kbd-text', str);
        },

        kbdKeyPress(code, modifiers) {
            return this.call('kbd-key-press', code, modifiers);
        },

        kbdShortcut(code, modifiers) {
            return this.call('kbd-shortcut', code, modifiers);
        },

        kbdKeyMoveWithCode(down, code, modifiers) {
            return this.call('kbd-key-move-with-code', down, code, modifiers);
        },

        kbdKeyMoveWithModifier(down, modifiers) {
            return this.call('kbd-key-move-with-modifier', down, modifiers);
        },

        kbdKeyMoveWithCharacter(down, character, code, modifiers) {
            return this.call('kbd-key-move-with-character', down, character, code, modifiers);
        }
    };

    global.NativeModules = NativeModules;
}

export { NativeModules };
