const express = require('express');
const router = express.Router();
const { ipcRequest } = require('../ipcBridge');

router.get('/', async (req, res) => {
    try {
        const sessions = await ipcRequest(req, 'get-sessions');
        res.json(sessions);
    } catch (error) {
        console.error('Failed to get sessions via IPC:', error);
        res.status(500).json({ error: 'Failed to retrieve sessions' });
    }
});

router.post('/', async (req, res) => {
    try {
        const result = await ipcRequest(req, 'create-session', req.body);
        res.status(201).json({ ...result, message: 'Session created successfully' });
    } catch (error) {
        console.error('Failed to create session via IPC:', error);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

// MUST stay above '/:session_id'. Express matches in declaration order, so with the parameterised
// route first this resolves as a session whose id is the literal string "search" and 404s - which
// is exactly how search was silently dead before.
router.get('/search', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    if (!query.trim()) {
        return res.json({ scope: 'content', results: [] });
    }

    try {
        const result = await ipcRequest(req, 'search-sessions', { query });
        res.json(result);
    } catch (error) {
        console.error('Failed to search sessions via IPC:', error);
        res.status(500).json({ error: 'Failed to search conversations' });
    }
});

// Action items across every session, for the cross-session review. Also above '/:session_id'.
router.get('/actions', async (req, res) => {
    try {
        const rows = await ipcRequest(req, 'get-action-items');
        res.json(rows);
    } catch (error) {
        console.error('Failed to get action items via IPC:', error);
        res.status(500).json({ error: 'Failed to retrieve action items' });
    }
});

router.get('/:session_id', async (req, res) => {
    try {
        const details = await ipcRequest(req, 'get-session-details', req.params.session_id);
        if (!details) {
            return res.status(404).json({ error: 'Session not found' });
        }
        res.json(details);
    } catch (error) {
        console.error(`Failed to get session details via IPC for ${req.params.session_id}:`, error);
        res.status(500).json({ error: 'Failed to retrieve session details' });
    }
});

router.put('/:session_id/actions', async (req, res) => {
    const done = req.body?.done;
    if (!Array.isArray(done) || done.some(item => typeof item !== 'string')) {
        return res.status(400).json({ error: 'Body must be { done: string[] }' });
    }

    try {
        const result = await ipcRequest(req, 'update-action-done', {
            sessionId: req.params.session_id,
            done,
        });
        res.json(result);
    } catch (error) {
        console.error(`Failed to update action items via IPC for ${req.params.session_id}:`, error);
        res.status(500).json({ error: 'Failed to update action items' });
    }
});

router.delete('/:session_id', async (req, res) => {
    try {
        await ipcRequest(req, 'delete-session', req.params.session_id);
        res.status(200).json({ message: 'Session deleted successfully' });
    } catch (error) {
        console.error(`Failed to delete session via IPC for ${req.params.session_id}:`, error);
        res.status(500).json({ error: 'Failed to delete session' });
    }
});

module.exports = router;
