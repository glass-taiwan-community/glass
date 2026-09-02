const { globalShortcut, screen } = require('electron');
const shortcutsRepository = require('./repositories');
const internalBridge = require('../../bridge/internalBridge');
const askService = require('../ask/askService');

// Actions that were shipped as keybinds but never implemented. They are filtered out of
// the loaded keybinds so they are neither registered as global shortcuts nor advertised in
// the shortcut editor. previousResponse/nextResponse default to Cmd+[ / Cmd+], which are
// browser back/forward -- registering them stole those keys system-wide to drive handlers
// that do not exist. Restore an entry here once the feature behind it is actually built.
const RETIRED_ACTIONS = new Set(['previousResponse', 'nextResponse']);


class ShortcutsService {
    constructor() {
        this.lastVisibleWindows = new Set(['header']);
        this.mouseEventsIgnored = false;
        this.windowPool = null;
        this.allWindowVisibility = true;
    }

    initialize(windowPool) {
        this.windowPool = windowPool;
        internalBridge.on('reregister-shortcuts', () => {
            console.log('[ShortcutsService] Reregistering shortcuts due to header state change.');
            this.registerShortcuts();
        });
        console.log('[ShortcutsService] Initialized with dependencies and event listener.');
    }

    async openShortcutSettingsWindow () {
        const keybinds = await this.loadKeybinds();
        const shortcutWin = this.windowPool.get('shortcut-settings');
        shortcutWin.webContents.send('shortcut:loadShortcuts', keybinds);

        globalShortcut.unregisterAll();
        internalBridge.emit('window:requestVisibility', { name: 'shortcut-settings', visible: true });
        console.log('[ShortcutsService] Shortcut settings window opened.');
        return { success: true };
    }

    async closeShortcutSettingsWindow () {
        await this.registerShortcuts();
        internalBridge.emit('window:requestVisibility', { name: 'shortcut-settings', visible: false });
        console.log('[ShortcutsService] Shortcut settings window closed.');
        return { success: true };
    }

    async handleSaveShortcuts(newKeybinds) {
        try {
            await this.saveKeybinds(newKeybinds);
            await this.closeShortcutSettingsWindow();
            return { success: true };
        } catch (error) {
            console.error("Failed to save shortcuts:", error);
            await this.closeShortcutSettingsWindow();
            return { success: false, error: error.message };
        }
    }

    async handleRestoreDefaults() {
        const defaults = this.getDefaultKeybinds();
        return defaults;
    }

    getDefaultKeybinds() {
        const isMac = process.platform === 'darwin';
        return {
            moveUp: isMac ? 'Cmd+Up' : 'Ctrl+Up',
            moveDown: isMac ? 'Cmd+Down' : 'Ctrl+Down',
            moveLeft: isMac ? 'Cmd+Left' : 'Ctrl+Left',
            moveRight: isMac ? 'Cmd+Right' : 'Ctrl+Right',
            toggleVisibility: isMac ? 'Cmd+\\' : 'Ctrl+\\',
            toggleClickThrough: isMac ? 'Cmd+M' : 'Ctrl+M',
            nextStep: isMac ? 'Cmd+Enter' : 'Ctrl+Enter',
            manualScreenshot: isMac ? 'Cmd+Shift+S' : 'Ctrl+Shift+S',
            scrollUp: isMac ? 'Cmd+Shift+Up' : 'Ctrl+Shift+Up',
            scrollDown: isMac ? 'Cmd+Shift+Down' : 'Ctrl+Shift+Down',
            scrollListenUp: isMac ? 'Cmd+Alt+Up' : 'Ctrl+Alt+Up',
            scrollListenDown: isMac ? 'Cmd+Alt+Down' : 'Ctrl+Alt+Down',
            toggleListenView: isMac ? 'Cmd+Alt+T' : 'Ctrl+Alt+T',
            activateListenItem: isMac ? 'Cmd+Alt+Enter' : 'Ctrl+Alt+Enter',
            // Deliberately not bare Escape: a global shortcut would take Escape from every
            // other application, breaking dialogs, menus and fullscreen everywhere.
            closeAsk: isMac ? 'Cmd+Alt+\\' : 'Ctrl+Alt+\\',
            // Deliberately NOT a second press of closeAsk. The pinned answer is the one the user
            // kept on purpose and the live one is disposable, so closing them with the same
            // gesture would put one extra keypress between the user and losing the deliberate
            // one - with no way to tell, mid-conversation, which window the first press closed.
            togglePinnedAnswer: isMac ? 'Cmd+Alt+P' : 'Ctrl+Alt+P',
            toggleListenSession: isMac ? 'Cmd+Alt+L' : 'Ctrl+Alt+L',
            edgeSnapLeft: isMac ? 'Cmd+Shift+Alt+Left' : 'Ctrl+Shift+Alt+Left',
            edgeSnapRight: isMac ? 'Cmd+Shift+Alt+Right' : 'Ctrl+Shift+Alt+Right',
            edgeSnapUp: isMac ? 'Cmd+Shift+Alt+Up' : 'Ctrl+Shift+Alt+Up',
            edgeSnapDown: isMac ? 'Cmd+Shift+Alt+Down' : 'Ctrl+Shift+Alt+Down',
        };
    }

    async loadKeybinds() {
        let keybindsArray = await shortcutsRepository.getAllKeybinds();

        if (!keybindsArray || keybindsArray.length === 0) {
            console.log(`[Shortcuts] No keybinds found. Loading defaults.`);
            const defaults = this.getDefaultKeybinds();
            await this.saveKeybinds(defaults); 
            return defaults;
        }

        const keybinds = {};
        keybindsArray.forEach(k => {
            if (RETIRED_ACTIONS.has(k.action)) return;
            keybinds[k.action] = k.accelerator;
        });

        const defaults = this.getDefaultKeybinds();
        let needsUpdate = false;
        for (const action in defaults) {
            if (!keybinds[action]) {
                keybinds[action] = defaults[action];
                needsUpdate = true;
            }
        }

        if (needsUpdate) {
            console.log('[Shortcuts] Updating missing keybinds with defaults.');
            await this.saveKeybinds(keybinds);
        }

        return keybinds;
    }

    async saveKeybinds(newKeybinds) {
        const keybindsToSave = [];
        for (const action in newKeybinds) {
            if (Object.prototype.hasOwnProperty.call(newKeybinds, action)) {
                keybindsToSave.push({
                    action: action,
                    accelerator: newKeybinds[action],
                });
            }
        }
        await shortcutsRepository.upsertKeybinds(keybindsToSave);
        console.log(`[Shortcuts] Saved keybinds.`);
    }

    async toggleAllWindowsVisibility() {
        const targetVisibility = !this.allWindowVisibility;
        internalBridge.emit('window:requestToggleAllWindowsVisibility', {
            targetVisibility: targetVisibility
        });

        if (this.allWindowVisibility) {
            await this.registerShortcuts(true);
        } else {
            await this.registerShortcuts();
        }

        this.allWindowVisibility = !this.allWindowVisibility;
    }

    async registerShortcuts(registerOnlyToggleVisibility = false) {
        if (!this.windowPool) {
            console.error('[Shortcuts] Service not initialized. Cannot register shortcuts.');
            return;
        }
        const keybinds = await this.loadKeybinds();
        globalShortcut.unregisterAll();
        
        const header = this.windowPool.get('header');
        const mainWindow = header;

        const sendToRenderer = (channel, ...args) => {
            this.windowPool.forEach(win => {
                if (win && !win.isDestroyed()) {
                    try {
                        win.webContents.send(channel, ...args);
                    } catch (e) {
                        // Ignore errors for destroyed windows
                    }
                }
            });
        };
        
        const sendToListen = (channel) => {
            const listenWindow = this.windowPool.get('listen');
            if (listenWindow && !listenWindow.isDestroyed() && listenWindow.isVisible()) {
                listenWindow.webContents.send(channel);
            }
        };

        sendToRenderer('shortcuts-updated', keybinds);

        if (registerOnlyToggleVisibility) {
            if (keybinds.toggleVisibility) {
                globalShortcut.register(keybinds.toggleVisibility, () => this.toggleAllWindowsVisibility());
            }
            console.log('[Shortcuts] registerOnlyToggleVisibility, only toggleVisibility shortcut is registered.');
            return;
        }

        // --- Hardcoded shortcuts ---
        const isMac = process.platform === 'darwin';
        const modifier = isMac ? 'Cmd' : 'Ctrl';
        
        // Monitor switching
        const displays = screen.getAllDisplays();
        if (displays.length > 1) {
            displays.forEach((display, index) => {
                const key = `${modifier}+Shift+${index + 1}`;
                globalShortcut.register(key, () => internalBridge.emit('window:moveToDisplay', { displayId: display.id }));
            });
        }

        // --- User-configurable shortcuts ---
        if (header?.currentHeaderState === 'apikey') {
            if (keybinds.toggleVisibility) {
                globalShortcut.register(keybinds.toggleVisibility, () => this.toggleAllWindowsVisibility());
            }
            console.log('[Shortcuts] ApiKeyHeader is active, only toggleVisibility shortcut is registered.');
            return;
        }

        const registered = [];
        const failed = [];
        const unhandled = [];

        for (const action in keybinds) {
            const accelerator = keybinds[action];
            if (!accelerator) continue;

            let callback;
            switch(action) {
                case 'toggleVisibility':
                    callback = () => this.toggleAllWindowsVisibility();
                    break;
                case 'nextStep':
                    callback = () => askService.toggleAskButton(true);
                    break;
                case 'scrollUp':
                    callback = () => {
                        const askWindow = this.windowPool.get('ask');
                        if (askWindow && !askWindow.isDestroyed() && askWindow.isVisible()) {
                            askWindow.webContents.send('ask:scrollResponseUp');
                        }
                    };
                    break;
                case 'scrollDown':
                    callback = () => {
                        const askWindow = this.windowPool.get('ask');
                        if (askWindow && !askWindow.isDestroyed() && askWindow.isVisible()) {
                            askWindow.webContents.send('ask:scrollResponseDown');
                        }
                    };
                    break;
                // Listen gets its own bindings rather than sharing the Ask ones. No Glass
                // window is ever the key window, so there is no focused-window rule to fall
                // back on -- the target has to be named explicitly by the shortcut itself.
                case 'scrollListenUp':
                    callback = () => sendToListen('listen:scrollUp');
                    break;
                case 'scrollListenDown':
                    callback = () => sendToListen('listen:scrollDown');
                    break;
                case 'toggleListenView':
                    callback = () => sendToListen('listen:toggleViewMode');
                    break;
                case 'activateListenItem':
                    callback = () => sendToListen('listen:activateItem');
                    break;
                case 'toggleListenSession':
                    // The header owns listenSessionStatus, so it decides between start,
                    // stop and dismiss. Sending it the same event a click produces keeps
                    // one state machine rather than duplicating it in the main process.
                    callback = () => {
                        if (header && !header.isDestroyed()) {
                            header.webContents.send('shortcut:toggleListenSession');
                        }
                    };
                    break;
                case 'closeAsk':
                    // Same path as the window's X button, so an in-flight stream is aborted
                    // rather than left running behind a hidden window.
                    callback = () => askService.closeAskWindow();
                    break;
                case 'togglePinnedAnswer':
                    // One key for both directions: pinning was deliberate, so unpinning gets its
                    // own deliberate action rather than being reachable by repeating a close.
                    callback = () => askService.togglePinnedAnswer();
                    break;
                case 'moveUp':
                    callback = () => { if (header && header.isVisible()) internalBridge.emit('window:moveStep', { direction: 'up' }); };
                    break;
                case 'moveDown':
                    callback = () => { if (header && header.isVisible()) internalBridge.emit('window:moveStep', { direction: 'down' }); };
                    break;
                case 'moveLeft':
                    callback = () => { if (header && header.isVisible()) internalBridge.emit('window:moveStep', { direction: 'left' }); };
                    break;
                case 'moveRight':
                    callback = () => { if (header && header.isVisible()) internalBridge.emit('window:moveStep', { direction: 'right' }); };
                    break;
                // Edge snap jumps the header to a screen edge. moveToEdge already handles
                // all four directions; these are the bindings that reach it.
                case 'edgeSnapLeft':
                    callback = () => { if (header && header.isVisible()) internalBridge.emit('window:moveToEdge', { direction: 'left' }); };
                    break;
                case 'edgeSnapRight':
                    callback = () => { if (header && header.isVisible()) internalBridge.emit('window:moveToEdge', { direction: 'right' }); };
                    break;
                case 'edgeSnapUp':
                    callback = () => { if (header && header.isVisible()) internalBridge.emit('window:moveToEdge', { direction: 'up' }); };
                    break;
                case 'edgeSnapDown':
                    callback = () => { if (header && header.isVisible()) internalBridge.emit('window:moveToEdge', { direction: 'down' }); };
                    break;
                case 'toggleClickThrough':
                     callback = () => {
                        this.mouseEventsIgnored = !this.mouseEventsIgnored;
                        if(mainWindow && !mainWindow.isDestroyed()){
                            mainWindow.setIgnoreMouseEvents(this.mouseEventsIgnored, { forward: true });
                            mainWindow.webContents.send('click-through-toggled', this.mouseEventsIgnored);
                        }
                     };
                     break;
                case 'manualScreenshot':
                    callback = () => {
                        if(mainWindow && !mainWindow.isDestroyed()) {
                             mainWindow.webContents.executeJavaScript('window.captureManualScreenshot && window.captureManualScreenshot();');
                        }
                    };
                    break;
            }
            
            if (!callback) {
                // An action with a keybind but no case here is registered nowhere and does
                // nothing. Silence made that indistinguishable from a working shortcut.
                unhandled.push(action);
                continue;
            }

            try {
                // register() returns false when the accelerator is refused - most often because
                // another application already holds it - and does NOT throw. Ignoring the return
                // value made a failed registration completely silent, which is the same failure
                // shape as a shortcut that was never added: nothing happens, and nothing says why.
                const ok = globalShortcut.register(accelerator, callback);
                if (ok) registered.push(`${action}=${accelerator}`);
                else failed.push(`${action}=${accelerator}`);
            } catch(e) {
                failed.push(`${action}=${accelerator}`);
                console.error(`[Shortcuts] Failed to register shortcut for "${action}" (${accelerator}):`, e.message);
            }
        }

        console.log(`[Shortcuts] Registered ${registered.length}: ${registered.join(', ')}`);
        if (failed.length) {
            console.warn(`[Shortcuts] REFUSED by the OS (already taken by another app?): ${failed.join(', ')}`);
        }
        if (unhandled.length) {
            console.warn(`[Shortcuts] Keybind defined but no handler, so it does nothing: ${unhandled.join(', ')}`);
        }
    }

    unregisterAll() {
        globalShortcut.unregisterAll();
        console.log('[Shortcuts] All shortcuts have been unregistered.');
    }
}


const shortcutsService = new ShortcutsService();

module.exports = shortcutsService;