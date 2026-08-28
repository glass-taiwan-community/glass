const sqliteRepository = require('./sqlite.repository');
const firebaseRepository = require('./firebase.repository');
const authService = require('../../common/services/authService');

function getBaseRepository() {
    const user = authService.getCurrentUser();
    if (user && user.isLoggedIn) {
        return firebaseRepository;
    }
    return sqliteRepository;
}

const settingsRepositoryAdapter = {
    getPresets: () => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().getPresets(uid);
    },

    getPresetTemplates: () => {
        return getBaseRepository().getPresetTemplates();
    },

    createPreset: (options) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().createPreset({ uid, ...options });
    },

    updatePreset: (id, options) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().updatePreset(id, options, uid);
    },

    deletePreset: (id) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().deletePreset(id, uid);
    },

    getAutoUpdate: () => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().getAutoUpdate(uid);
    },

    setAutoUpdate: (isEnabled) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().setAutoUpdate(uid, isEnabled);
    },

    getSttLanguage: () => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().getSttLanguage(uid);
    },

    setSttLanguage: (language) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().setSttLanguage(uid, language);
    },

    getVoiceAskEnabled: () => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().getVoiceAskEnabled(uid);
    },

    setVoiceAskEnabled: (enabled) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().setVoiceAskEnabled(uid, enabled);
    },

    getSaveAskScreenshots: () => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().getSaveAskScreenshots(uid);
    },

    setSaveAskScreenshots: (enabled) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().setSaveAskScreenshots(uid, enabled);
    },
};

module.exports = settingsRepositoryAdapter;
