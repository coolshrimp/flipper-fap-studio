const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return {};
    return originalLoad.call(this, request, parent, isMain);
};

const { simulatorPanelTestHooks } = require('../out/simulatorPanel');

const model = {
    appFolder: 'C:\\Apps\\hello',
    appName: 'Hello <Flipper>',
    appId: 'hello',
    entryPoint: 'app_main',
    targetId: 'oem',
    targetOptions: [{ id: 'oem', label: 'OEM / uFBT', path: '' }],
    firmware: { kind: 'managed', title: 'OEM / uFBT', detail: 'Managed SDK', path: 'C:\\Users\\test\\.ufbt' },
    engine: { available: true, executable: 'C:\\tools\\stm32-emulator.exe', detail: 'ready' },
    fap: null,
    parse: {
        screens: [{ name: 'Main', sourceFile: 'main.c', commands: [{ op: 'text', args: [4, 12, 'Hi'], raw: '' }] }],
        bitmaps: {},
        warnings: [],
        parsedCalls: 1,
    },
};

const output = simulatorPanelTestHooks.html({ cspSource: 'test-source' }, model);
const refreshedOutput = simulatorPanelTestHooks.html({ cspSource: 'test-source' }, model, false);
assert.ok(output.includes('Flipper Simulator'));
assert.ok(output.includes('Hello &lt;Flipper&gt;'));
assert.ok(!output.includes('Hello <Flipper>'));
assert.ok(output.includes('var stride = Math.ceil(w / 8);'));
assert.ok(output.includes('budget = 100000;'));
assert.ok(output.includes('function drawAlignedText'));
assert.ok(output.includes("case 'textAligned'"));
assert.ok(output.includes("source: 'firmware'"), 'CFW input must be routed to the firmware engine');
assert.ok(output.includes("source: 'app'"), 'app input must be routed only to the desktop bridge');
assert.ok(output.includes('● CFW FUNCTIONAL'), 'live firmware frames must not be labeled static preview');
assert.ok(output.includes("firmwareProcessActive && firmwareActive"));
assert.ok(output.includes('function drawPreparation()'));
assert.ok(output.includes('Preparing selected firmware...'));
assert.ok(output.includes("addEventListener('pointerdown'"), 'D-pad buttons should detect press-and-hold');
assert.ok(output.includes("input(buttonEl.dataset.key, 'long')"), 'D-pad holds should send long input');
assert.ok(output.includes("addEventListener('keyup'"), 'keyboard holds should finish on key release');
assert.ok(output.includes("document.getElementById('btnRuntime').click();"), 'first render should auto-boot');
assert.ok(
    !refreshedOutput.includes("document.getElementById('btnRuntime').click();"),
    'an HTML refresh must not start another firmware session',
);

const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(output)?.[1];
assert.ok(script, 'webview script should be present');
assert.doesNotThrow(() => new Function(script), 'generated webview JavaScript should parse');

class FakeElement {
    constructor(document, id, tagName = 'DIV') {
        this.document = document;
        this.id = id;
        this.tagName = tagName;
        this.dataset = {};
        this.style = {};
        this.textContent = '';
        this.value = '';
        this.disabled = false;
        this.listeners = new Map();
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    click() {
        if (this.disabled) return;
        const event = { target: this, currentTarget: this, preventDefault() {} };
        for (const listener of this.listeners.get('pointerdown') || []) listener(event);
        for (const listener of this.listeners.get('pointerup') || []) listener(event);
        if (typeof this.onclick === 'function') this.onclick(event);
        for (const listener of this.listeners.get('click') || []) listener(event);
    }

    focus() {
        this.document.activeElement = this;
    }

    get scrollHeight() {
        return this.textContent.length;
    }

    getContext() {
        return {
            fillStyle: '',
            imageSmoothingEnabled: false,
            fillRect() {},
        };
    }

    toDataURL() {
        return 'data:image/png;base64,';
    }
}

function runWebviewScript(webviewScript) {
    const messages = [];
    const windowListeners = new Map();
    const elements = new Map();
    const tagForId = id => {
        if (id === 'screen') return 'CANVAS';
        if (id === 'screenSelect' || id === 'targetSelect') return 'SELECT';
        if (id.startsWith('btn')) return 'BUTTON';
        return 'DIV';
    };
    const document = {
        activeElement: null,
        getElementById(id) {
            if (!elements.has(id)) {
                elements.set(id, new FakeElement(document, id, tagForId(id)));
            }
            return elements.get(id);
        },
        createElement(tagName) {
            return new FakeElement(document, '', String(tagName).toUpperCase());
        },
        querySelectorAll(selector) {
            return selector === '[data-key]' ? Object.values(keyButtons) : [];
        },
    };
    const keyButtons = {};
    for (const key of ['UP', 'DOWN', 'LEFT', 'RIGHT', 'OK', 'BACK']) {
        const element = new FakeElement(document, `key-${key}`, 'BUTTON');
        element.dataset.key = key;
        keyButtons[key] = element;
    }
    const window = {
        addEventListener(type, listener) {
            const listeners = windowListeners.get(type) || [];
            listeners.push(listener);
            windowListeners.set(type, listeners);
        },
        dispatch(type, event) {
            for (const listener of windowListeners.get(type) || []) listener(event);
        },
    };
    const acquireVsCodeApi = () => ({
        postMessage(message) {
            messages.push(message);
        },
    });

    new Function('window', 'document', 'acquireVsCodeApi', webviewScript)(
        window,
        document,
        acquireVsCodeApi,
    );

    return {
        messages,
        keyButtons,
        element: id => document.getElementById(id),
        send(message) {
            window.dispatch('message', { data: message });
        },
        clearMessages() {
            messages.splice(0, messages.length);
        },
        runtimeInputs() {
            return messages.filter(message => message.type === 'runtimeInput');
        },
    };
}

const harness = runWebviewScript(script);
assert.ok(
    harness.messages.some(message => message.type === 'runtimeStart'),
    'webview should request its automatic runtime start',
);
harness.clearMessages();

// Automatic boot immediately replaces the offline preview with a preparation
// screen and locks input until the first real firmware framebuffer arrives.
assert.match(harness.element('runState').textContent, /PREPARING CFW 2%/);
assert.equal(harness.keyButtons.RIGHT.disabled, true);
harness.keyButtons.RIGHT.click();
assert.deepEqual(harness.runtimeInputs(), [], 'preparation input must not reach either runtime');
harness.send({
    type: 'stm32Status',
    state: 'starting',
    progress: 42,
    text: 'Preparing resources.tar.gz for the virtual SD...',
});
assert.match(harness.element('runState').textContent, /PREPARING CFW 42%/);
assert.match(harness.element('log').textContent, /Preparing resources\.tar\.gz for the virtual SD/);

// Bring both engines online. Firmware boot is the initial display source, and
// the source toggle exposes the app bridge after a real CFW frame is present.
harness.send({ type: 'runtimeStatus', state: 'running' });
harness.send({ type: 'stm32Status', state: 'starting' });
harness.send({ type: 'stm32Status', state: 'running' });
harness.send({ type: 'stm32Frame', hex: '00'.repeat(1024) });
assert.equal(harness.keyButtons.RIGHT.disabled, false);
assert.equal(harness.element('btnDisplaySource').textContent, 'View App');
assert.match(harness.element('runState').textContent, /CFW FUNCTIONAL/);

harness.clearMessages();
harness.keyButtons.DOWN.click();
assert.deepEqual(
    harness.runtimeInputs(),
    [{ type: 'runtimeInput', source: 'firmware', key: 'DOWN', inputType: 'short' }],
    'visible running CFW must receive the input exclusively',
);

harness.element('btnDisplaySource').click();
assert.match(harness.element('runState').textContent, /APP FUNCTIONAL/);
harness.clearMessages();
harness.keyButtons.OK.click();
assert.deepEqual(
    harness.runtimeInputs(),
    [{ type: 'runtimeInput', source: 'app', key: 'OK', inputType: 'short' }],
    'visible running app must receive the input exclusively',
);

// A terminal firmware status must invalidate its last frame. When the app
// remains active, the panel explicitly switches to it before accepting input.
harness.element('btnDisplaySource').click();
assert.match(harness.element('runState').textContent, /CFW FUNCTIONAL/);
harness.send({ type: 'stm32Status', state: 'error', text: 'firmware stopped' });
assert.doesNotMatch(harness.element('runState').textContent, /CFW FUNCTIONAL/);
assert.match(harness.element('runState').textContent, /APP FUNCTIONAL/);
assert.equal(harness.element('btnDisplaySource').textContent, 'View CFW');
harness.clearMessages();
harness.keyButtons.LEFT.click();
assert.deepEqual(
    harness.runtimeInputs(),
    [{ type: 'runtimeInput', source: 'app', key: 'LEFT', inputType: 'short' }],
    'terminal CFW status must switch visibly to the app before app input is accepted',
);

// With no app runtime to switch to, a stopped CFW must neither remain
// functional nor leak its visible-screen input into another engine.
harness.send({ type: 'runtimeStatus', state: 'error' });
harness.send({ type: 'stm32Status', state: 'starting' });
harness.send({ type: 'stm32Status', state: 'running' });
harness.send({ type: 'stm32Frame', hex: 'ff'.repeat(1024) });
assert.match(harness.element('runState').textContent, /CFW FUNCTIONAL/);
harness.send({ type: 'stm32Status', state: 'stopped' });
assert.doesNotMatch(harness.element('runState').textContent, /CFW FUNCTIONAL/);
harness.send({ type: 'stm32Frame', hex: 'aa'.repeat(1024) });
assert.doesNotMatch(
    harness.element('runState').textContent,
    /CFW FUNCTIONAL/,
    'late firmware frames after process exit must be ignored',
);
harness.clearMessages();
harness.keyButtons.RIGHT.click();
assert.deepEqual(
    harness.runtimeInputs(),
    [],
    'stopped CFW input must not fall through to the inactive app bridge',
);

console.log('simulator panel HTML and behavior tests passed');
