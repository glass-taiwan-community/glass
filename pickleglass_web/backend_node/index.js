const express = require('express');
const cors = require('cors');
// const db = require('./db'); // No longer needed
const { identifyUser } = require('./middleware/auth');

function createApp(eventBridge) {
    const app = express();

    const webUrl = process.env.pickleglass_WEB_URL || 'http://localhost:3000';
    console.log(`🔧 Backend CORS configured for: ${webUrl}`);

    app.use(cors({
        origin: webUrl,
        credentials: true,
    }));

    app.use(express.json());

    app.get('/', (req, res) => {
        res.json({ message: "pickleglass API is running" });
    });

    app.use((req, res, next) => {
        req.bridge = eventBridge;
        next();
    });

    app.use('/api', identifyUser);

    app.use('/api/auth', require('./routes/auth'));
    app.use('/api/user', require('./routes/user'));
    app.use('/api/conversations', require('./routes/conversations'));
    app.use('/api/presets', require('./routes/presets'));
    app.use('/api/precontext', require('./routes/precontext'));

    // Serve saved screen-only Ask screenshots from userData/ask-screenshots. This express app
    // runs in the Electron main process, so it can read userData directly. path.basename
    // sanitizes the name to that directory -- no traversal, only files we wrote (uuid.jpg).
    app.get('/api/ask-screenshots/:file', (req, res) => {
        try {
            const path = require('path');
            const { app: electronApp } = require('electron');
            const dir = path.join(electronApp.getPath('userData'), 'ask-screenshots');
            const safe = path.basename(req.params.file);
            res.sendFile(path.join(dir, safe), (err) => { if (err && !res.headersSent) res.status(404).end(); });
        } catch (e) {
            res.status(500).end();
        }
    });

    app.get('/api/sync/status', (req, res) => {
        res.json({
            status: 'online',
            timestamp: new Date().toISOString(),
            version: '1.0.0'
        });
    });

    app.post('/api/desktop/set-user', (req, res) => {
        res.json({
            success: true,
            message: "Direct IPC communication is now used. This endpoint is deprecated.",
            user: req.body,
            deprecated: true
        });
    });

    app.get('/api/desktop/status', (req, res) => {
        res.json({
            connected: true,
            current_user: null,
            communication_method: "IPC",
            file_based_deprecated: true
        });
    });

    return app;
}

module.exports = createApp;
