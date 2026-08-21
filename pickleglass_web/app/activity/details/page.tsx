'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRedirectIfNotAuth } from '@/utils/auth'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  UserProfile,
  SessionDetails,
  Transcript,
  AiMessage,
  getSessionDetails,
  deleteSession,
} from '@/utils/api'

type ConversationItem = (Transcript & { type: 'transcript' }) | (AiMessage & { type: 'ai_message' });

const Section = ({ title, children }: { title: string, children: React.ReactNode }) => (
    <div className="mb-8">
        <h2 className="text-lg font-semibold text-gray-800 mb-3">{title}</h2>
        <div className="text-gray-700 space-y-2">
            {children}
        </div>
    </div>
);

function SessionDetailsContent() {
  const userInfo = useRedirectIfNotAuth() as UserProfile | null;
  const [sessionDetails, setSessionDetails] = useState<SessionDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('sessionId');
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (userInfo && sessionId) {
      const fetchDetails = async () => {
        setIsLoading(true);
        try {
          const details = await getSessionDetails(sessionId as string);
          setSessionDetails(details);
        } catch (error) {
          console.error('Failed to load session details:', error);
        } finally {
          setIsLoading(false);
        }
      };
      fetchDetails();
    }
  }, [userInfo, sessionId]);

  const handleDelete = async () => {
    if (!sessionId) return;
    if (!window.confirm('Are you sure you want to delete this activity? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await deleteSession(sessionId);
      router.push('/activity');
    } catch (error) {
      alert('Failed to delete activity.');
      setDeleting(false);
      console.error(error);
    }
  };

  if (!userInfo || isLoading) {
    return (
      <div className="min-h-screen bg-[#FDFCF9] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading session details...</p>
        </div>
      </div>
    );
  }

  if (!sessionDetails) {
    return (
        <div className="min-h-screen bg-[#FDFCF9] flex items-center justify-center">
            <div className="max-w-4xl mx-auto px-8 py-12 text-center">
                <h2 className="text-2xl font-semibold text-gray-900 mb-8">Session Not Found</h2>
                <p className="text-gray-600">The requested session could not be found.</p>
                                    <Link href="/activity" className="mt-4 inline-block text-blue-600 hover:text-blue-800">
                        &larr; Back to Activity
                    </Link>
            </div>
        </div>
    )
  }
  
  const askMessages = sessionDetails.ai_messages || [];

  return (
    <div className="min-h-screen bg-[#FDFCF9] text-gray-800">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
            <div className="mb-8">
                <Link href="/activity" className="text-sm text-gray-500 hover:text-gray-700 flex items-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back
                </Link>
            </div>

            <div className="bg-white p-8 rounded-xl shadow-md border border-gray-100">
                <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 mb-2">
                            {sessionDetails.session.title || `Conversation on ${new Date(sessionDetails.session.started_at * 1000).toLocaleDateString()}`}
                        </h1>
                        <div className="flex items-center text-sm text-gray-500 space-x-4">
                            <span>{new Date(sessionDetails.session.started_at * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                            <span>{new Date(sessionDetails.session.started_at * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</span>
                            <span className={`capitalize px-2 py-0.5 rounded-full text-xs font-medium ${sessionDetails.session.session_type === 'listen' ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'}`}>
                                {sessionDetails.session.session_type}
                            </span>
                        </div>
                    </div>
                    <button
                        onClick={handleDelete}
                        disabled={deleting}
                        className={`px-4 py-2 rounded text-sm font-medium border border-red-200 text-red-700 bg-red-50 hover:bg-red-100 transition-colors ${deleting ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                        {deleting ? 'Deleting...' : 'Delete Activity'}
                    </button>
                </div>

                {sessionDetails.summary && (() => {
                    // Switch on the WHOLE artifact, never field by field. The live snapshot only
                    // covers the last 30 turns and is rewritten every 5, so mixing its bullets
                    // under a whole-session headline yields a summary that contradicts itself.
                    const isFinal = Boolean(sessionDetails.summary.final_generated_at)
                    const view = isFinal
                        ? {
                            tldr: sessionDetails.summary.final_tldr,
                            bullet_json: sessionDetails.summary.final_bullet_json,
                            action_json: sessionDetails.summary.final_action_json,
                          }
                        : {
                            tldr: sessionDetails.summary.tldr,
                            bullet_json: sessionDetails.summary.bullet_json,
                            action_json: sessionDetails.summary.action_json,
                          }

                    const parse = (json?: string | null): string[] => {
                        if (!json) return []
                        try { return JSON.parse(json) } catch { return [] }
                    }
                    const bullets = parse(view.bullet_json)
                    const actions = parse(view.action_json)

                    return (
                    <Section title="Summary">
                        {/* The two artifacts are not interchangeable and cannot be told apart by
                            reading them, so label which one is on screen. "（部分）" is doing real
                            work: it warns that early material may be missing and the transcript
                            below is the authority. */}
                        <div className="mb-3">
                            <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                                isFinal ? 'bg-green-50 text-green-700 border border-green-200'
                                        : 'bg-amber-50 text-amber-700 border border-amber-200'
                            }`}>
                                {isFinal ? '完整會議摘要' : '即時摘要（部分）'}
                            </span>
                        </div>

                        {view.tldr && <p className="text-lg italic text-gray-600 mb-4">"{view.tldr}"</p>}

                        {bullets.length > 0 &&
                            <div className="mt-4">
                                <h3 className="font-semibold text-gray-700 mb-2">Key Points:</h3>
                                <ul className="list-disc list-inside space-y-1 text-gray-600">
                                    {bullets.map((point: string, index: number) => (
                                        <li key={index}>{point}</li>
                                    ))}
                                </ul>
                            </div>
                        }

                        {actions.length > 0 &&
                            <div className="mt-4">
                                <h3 className="font-semibold text-gray-700 mb-2">Action Items:</h3>
                                <ul className="list-disc list-inside space-y-1 text-gray-600">
                                    {actions.map((action: string, index: number) => (
                                        <li key={index}>{action}</li>
                                    ))}
                                </ul>
                            </div>
                        }
                    </Section>
                    )
                })()}
                
                {sessionDetails.transcripts && sessionDetails.transcripts.length > 0 && (
                    <Section title="Listen: Transcript">
                        <div className="space-y-3">
                            {sessionDetails.transcripts.map((item) => (
                                <p key={item.id} className="text-gray-700">
                                    <span className="font-semibold capitalize">{item.speaker}: </span>
                                    {item.text}
                                </p>
                            ))}
                        </div>
                    </Section>
                )}
                
                {askMessages.length > 0 && (
                    <Section title="Ask: Q&A">
                        <div className="space-y-4">
                            {askMessages.map((item) => (
                                <div key={item.id} className={`p-3 rounded-lg ${item.role === 'user' ? 'bg-gray-100' : 'bg-blue-50'}`}>
                                    <p className="font-semibold capitalize text-sm text-gray-600 mb-1">{item.role === 'user' ? 'You' : 'AI'}</p>
                                    <p className="text-gray-800 whitespace-pre-wrap">{item.content}</p>
                                </div>
                            ))}
                        </div>
                    </Section>
                )}
            </div>
        </div>
    </div>
  );
}

export default function SessionDetailsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#FDFCF9] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    }>
      <SessionDetailsContent />
    </Suspense>
  );
} 