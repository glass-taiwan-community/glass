const sqliteRepository = require('./sqlite.repository');
const authService = require('../../services/authService');

const preContextRepositoryAdapter = {
    get: () => {
        const uid = authService.getCurrentUserId();
        return sqliteRepository.getByUid(uid);
    },

    save: ({ title, content }) => {
        const uid = authService.getCurrentUserId();
        return sqliteRepository.upsert(uid, { title, content });
    },
};

module.exports = preContextRepositoryAdapter;
