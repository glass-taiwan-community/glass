const express = require('express');
const router = express.Router();
const { ipcRequest } = require('../ipcBridge');

router.get('/', async (req, res) => {
    try {
        const data = await ipcRequest(req, 'get-pre-context');
        res.json(data);
    } catch (error) {
        console.error('Failed to get pre-context via IPC:', error);
        res.status(500).json({ error: 'Failed to retrieve pre-context' });
    }
});

router.post('/', async (req, res) => {
    try {
        await ipcRequest(req, 'save-pre-context', req.body);
        res.json({ success: true });
    } catch (error) {
        console.error('Failed to save pre-context via IPC:', error);
        res.status(500).json({ error: 'Failed to save pre-context' });
    }
});

router.post('/preload-and-start', async (req, res) => {
    try {
        const result = await ipcRequest(req, 'preload-and-start-session', req.body);
        res.json(result);
    } catch (error) {
        console.error('Failed to preload-and-start session via IPC:', error);
        res.status(500).json({ error: 'Failed to start session with pre-context' });
    }
});

module.exports = router;
