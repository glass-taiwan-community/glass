const express = require('express');
const router = express.Router();
const { ipcRequest } = require('../ipcBridge');

router.get('/', async (req, res) => {
    try {
        res.json(await ipcRequest(req, 'get-snippets'));
    } catch (error) {
        console.error('Failed to get snippets via IPC:', error);
        res.status(500).json({ error: 'Failed to retrieve snippets' });
    }
});

router.post('/', async (req, res) => {
    try {
        const result = await ipcRequest(req, 'create-snippet', req.body);
        res.status(201).json({ ...result, message: 'Snippet created successfully' });
    } catch (error) {
        console.error('Failed to create snippet via IPC:', error);
        res.status(500).json({ error: 'Failed to create snippet' });
    }
});

router.put('/:id', async (req, res) => {
    try {
        await ipcRequest(req, 'update-snippet', { id: req.params.id, data: req.body });
        res.json({ message: 'Snippet updated successfully' });
    } catch (error) {
        console.error('Failed to update snippet via IPC:', error);
        res.status(500).json({ error: 'Failed to update snippet' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await ipcRequest(req, 'delete-snippet', req.params.id);
        res.json({ message: 'Snippet deleted successfully' });
    } catch (error) {
        console.error('Failed to delete snippet via IPC:', error);
        res.status(500).json({ error: 'Failed to delete snippet' });
    }
});

module.exports = router;
