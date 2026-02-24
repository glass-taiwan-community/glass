'use client'

import { useState, useEffect } from 'react'
import { getPreContext, savePreContext, preloadAndStartSession, PreContext } from '@/utils/api'

export default function PreContextPage() {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const data = await getPreContext();
        if (data) {
          setTitle(data.title || '');
          setContent(data.content || '');
        }
      } catch (error) {
        console.error('Failed to load pre-context:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const handleSave = async () => {
    if (saving) return;
    try {
      setSaving(true);
      setStatusMessage('');
      await savePreContext({ title, content });
      setStatusMessage('Saved successfully.');
    } catch (error) {
      console.error('Failed to save pre-context:', error);
      setStatusMessage('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handlePreloadAndStart = async () => {
    if (starting) return;
    try {
      setStarting(true);
      setStatusMessage('');
      await preloadAndStartSession({ title, content });
      setStatusMessage('Session started with pre-context!');
    } catch (error) {
      console.error('Failed to preload and start session:', error);
      setStatusMessage('Failed to start session. Please try again.');
    } finally {
      setStarting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white border-b border-gray-100">
        <div className="px-8 pt-8 pb-6">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-sm text-gray-500 mb-2">Session Setup</p>
              <h1 className="text-3xl font-bold text-gray-900">Pre-Context</h1>
              <p className="text-sm text-gray-500 mt-1">Preload structured context before your session</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving || starting}
                className="px-4 py-2 rounded-md text-sm font-medium transition-all duration-200 bg-gray-600 text-white hover:bg-gray-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={handlePreloadAndStart}
                disabled={saving || starting || !content.trim()}
                className="px-4 py-2 rounded-md text-sm font-medium transition-all duration-200 bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                {starting ? 'Starting...' : 'Preload & Start Session'}
              </button>
            </div>
          </div>
          {statusMessage && (
            <p className={`mt-3 text-sm ${statusMessage.includes('Failed') ? 'text-red-600' : 'text-green-600'}`}>
              {statusMessage}
            </p>
          )}
        </div>
      </div>

      <div className="flex-1 bg-white overflow-auto">
        <div className="px-8 py-6 flex flex-col gap-4 h-full">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g., Today's Meeting Agenda"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div className="flex flex-col flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">Context</label>
            <p className="text-xs text-gray-500 mb-2">
              Enter structured content such as meeting agenda items, previous action items, or key participants.
            </p>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder={`- Meeting agenda item 1\n- Previous action item\n- Key participants: Alice, Bob\n- Goals for this session`}
              className="flex-1 w-full px-3 py-3 border border-gray-300 rounded-md text-sm text-gray-900 font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              style={{ minHeight: '300px' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
