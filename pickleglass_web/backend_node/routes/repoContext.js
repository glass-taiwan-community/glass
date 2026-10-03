const express = require('express');
const router = express.Router();
const { ipcRequest } = require('../ipcBridge');

router.get('/', async (req, res) => {
    try {
        res.json(await ipcRequest(req, 'get-repo-context'));
    } catch (error) {
        console.error('Failed to get repo context via IPC:', error);
        res.status(500).json({ error: 'Failed to retrieve repo context' });
    }
});

router.post('/', async (req, res) => {
    try {
        const result = await ipcRequest(req, 'save-repo-context', req.body);
        // A refusal is the user's typo and answers 400 carrying the reason the page renders
        // verbatim; a throw is our defect and stays a 500 below. Collapsing the two would make a
        // mistyped subpath indistinguishable from a broken handler.
        res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
        console.error('Failed to save repo context via IPC:', error);
        res.status(500).json({ error: 'Failed to save repo context' });
    }
});

module.exports = router;
