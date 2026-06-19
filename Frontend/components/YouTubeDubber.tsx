'use client';

import { useState, useEffect, useRef } from 'react';
import { Play, Download, Globe, Zap, CheckCircle, AlertCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const STEPS = [
  { key: 'fetching_transcript', label: 'Extracting transcript'           },
  { key: 'translating',         label: 'Translating content'             },
  { key: 'downloading_video',   label: 'Downloading video'               },
  { key: 'generating_audio',    label: 'Cloning voice & generating audio' },
  { key: 'merging',             label: 'Merging video'                   },
];

interface DubResult {
  status: 'completed';
  downloadUrl: string;
  transcriptSegments: number;
  translationErrors: number;
}

interface JobStatus {
  status: 'processing' | 'completed' | 'failed';
  step?: string;
  downloadUrl?: string;
  error?: string;
  transcriptSegments?: number;
  translationErrors?: number;
}

interface TranscriptSegment {
  text: string;
  translatedText: string;
  start: number;
  duration: number;
}

export default function YouTubeDubber() {
  const [videoUrl, setVideoUrl]         = useState('');
  const [targetLanguage, setTargetLanguage] = useState('spanish');
  const [isLoading, setIsLoading]       = useState(false);
  const [currentStep, setCurrentStep]   = useState<string | null>(null);
  const [result, setResult]             = useState<DubResult | null>(null);
  const [error, setError]               = useState('');
  const [jobId, setJobId]               = useState<string | null>(null);
  const [transcript, setTranscript]     = useState<TranscriptSegment[]>([]);
  const [showTranscript, setShowTranscript] = useState(false);
  const pollRef                         = useRef<ReturnType<typeof setInterval> | null>(null);

  const languages = [
    { code: 'spanish',    name: 'Spanish (Español)'       },
    { code: 'french',     name: 'French (Français)'       },
    { code: 'german',     name: 'German (Deutsch)'        },
    { code: 'italian',    name: 'Italian (Italiano)'      },
    { code: 'portuguese', name: 'Portuguese (Português)'  },
    { code: 'russian',    name: 'Russian (Русский)'       },
    { code: 'japanese',   name: 'Japanese (日本語)'        },
    { code: 'korean',     name: 'Korean (한국어)'          },
    { code: 'chinese',    name: 'Chinese (中文)'           },
    { code: 'hindi',      name: 'Hindi (हिंदी)'            },
    { code: 'arabic',     name: 'Arabic (العربية)'        },
    { code: 'dutch',      name: 'Dutch (Nederlands)'      },
    { code: 'polish',     name: 'Polish (Polski)'         },
    { code: 'turkish',    name: 'Turkish (Türkçe)'        },
    { code: 'thai',       name: 'Thai (ไทย)'              },
    { code: 'vietnamese', name: 'Vietnamese (Tiếng Việt)' },
  ];

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // Start polling whenever we get a jobId
  useEffect(() => {
    if (!jobId) return;

    pollRef.current = setInterval(async () => {
      try {
        const response = await fetch(`${API_URL}/api/job-status/${jobId}`);

        if (response.status === 404) {
          stopPolling();
          setError('Job not found — it may have expired. Please try again.');
          setIsLoading(false);
          return;
        }

        const data: JobStatus = await response.json();

        if (data.status === 'completed') {
          stopPolling();
          setResult({
            status: 'completed',
            downloadUrl: data.downloadUrl!,
            transcriptSegments: data.transcriptSegments ?? 0,
            translationErrors: data.translationErrors ?? 0,
          });
          setCurrentStep(null);
          setIsLoading(false);
          // Fetch transcript data for the viewer
          fetch(`${API_URL}/api/job-transcript/${jobId}`)
            .then(r => r.json())
            .then(d => { if (d.segments) setTranscript(d.segments); })
            .catch(() => {});
        } else if (data.status === 'failed') {
          stopPolling();
          setError(data.error || 'Dubbing job failed. Please try again.');
          setCurrentStep(null);
          setIsLoading(false);
        } else {
          setCurrentStep(data.step ?? null);
        }
      } catch {
        // Network hiccup — keep polling
      }
    }, 3000);

    return () => stopPolling();
  }, [jobId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    setResult(null);
    setCurrentStep(null);
    setJobId(null);

    try {
      const response = await fetch(`${API_URL}/api/dub-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl, targetLanguage }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start dubbing job');
      }

      setJobId(data.jobId);
      setCurrentStep('fetching_transcript');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setIsLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!jobId) return;
    try {
      const response = await fetch(`${API_URL}/api/download/${jobId}`);
      if (!response.ok) throw new Error('File not available');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'dubbed_video.mp4';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('Download failed. The file may have expired — try dubbing again.');
    }
  };

  const resetForm = () => {
    stopPolling();
    setVideoUrl('');
    setTargetLanguage('spanish');
    setResult(null);
    setError('');
    setJobId(null);
    setCurrentStep(null);
    setTranscript([]);
    setShowTranscript(false);
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const currentStepIndex = STEPS.findIndex(s => s.key === currentStep);

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-900 via-purple-900 to-indigo-900 relative overflow-hidden">
      {/* Animated background */}
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-72 h-72 bg-purple-500/20 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-500/20 rounded-full blur-3xl animate-pulse delay-1000"></div>
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-pink-500/20 rounded-full blur-3xl animate-pulse delay-2000"></div>
      </div>

      <div className="relative z-10 container mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-5xl md:text-7xl font-bold text-white mb-4 bg-gradient-to-r from-pink-400 via-purple-400 to-indigo-400 bg-clip-text text-transparent">
            🎙️ YouTube Video Dubber
          </h1>
          <p className="text-xl text-gray-300 max-w-2xl mx-auto">
            Transform any YouTube video into multiple languages with AI-powered dubbing
          </p>
        </div>

        {!result ? (
          <div className="max-w-2xl mx-auto">
            <div className="backdrop-blur-xl bg-white/10 rounded-3xl p-8 shadow-2xl border border-white/20">
              <form onSubmit={handleSubmit} className="space-y-6">
                {/* URL Input */}
                <div>
                  <label className="block text-white text-sm font-medium mb-3">
                    🎬 YouTube Video URL
                  </label>
                  <div className="relative">
                    <input
                      type="url"
                      value={videoUrl}
                      onChange={(e) => setVideoUrl(e.target.value)}
                      placeholder="https://www.youtube.com/watch?v=..."
                      className="w-full px-4 py-4 bg-white/10 border border-white/20 rounded-2xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-400 focus:border-transparent transition-all duration-300"
                      required
                      disabled={isLoading}
                    />
                    <Play className="absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                  </div>
                </div>

                {/* Language Select */}
                <div>
                  <label className="block text-white text-sm font-medium mb-3">
                    🌍 Target Language
                  </label>
                  <div className="relative">
                    <select
                      value={targetLanguage}
                      onChange={(e) => setTargetLanguage(e.target.value)}
                      disabled={isLoading}
                      className="w-full px-4 py-4 bg-white/10 border border-white/20 rounded-2xl text-white focus:outline-none focus:ring-2 focus:ring-purple-400 focus:border-transparent transition-all duration-300 appearance-none disabled:opacity-60"
                    >
                      {languages.map((lang) => (
                        <option key={lang.code} value={lang.code} className="bg-gray-800 text-white">
                          {lang.name}
                        </option>
                      ))}
                    </select>
                    <Globe className="absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5 pointer-events-none" />
                  </div>
                </div>

                {/* Error */}
                {error && (
                  <div className="flex items-center gap-3 p-4 bg-red-500/20 border border-red-500/30 rounded-2xl">
                    <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                    <p className="text-red-300 text-sm">{error}</p>
                  </div>
                )}

                {/* Submit */}
                <button
                  type="submit"
                  disabled={isLoading || !videoUrl.trim()}
                  className="w-full bg-gradient-to-r from-pink-500 to-violet-500 hover:from-pink-600 hover:to-violet-600 disabled:from-gray-600 disabled:to-gray-600 text-white font-semibold py-4 px-6 rounded-2xl transition-all duration-300 transform hover:scale-105 disabled:scale-100 disabled:cursor-not-allowed shadow-xl"
                >
                  {isLoading ? (
                    <div className="flex items-center justify-center gap-3">
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>Processing Magic...</span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center gap-3">
                      <Zap className="w-5 h-5" />
                      <span>Start Dubbing</span>
                    </div>
                  )}
                </button>
              </form>
            </div>

            {/* Live Progress */}
            {isLoading && (
              <div className="mt-8 backdrop-blur-xl bg-white/10 rounded-3xl p-8 shadow-2xl border border-white/20">
                <div className="text-center mb-6">
                  <div className="w-16 h-16 mx-auto mb-4 border-4 border-purple-400 border-t-transparent rounded-full animate-spin"></div>
                  <h3 className="text-xl font-semibold text-white mb-1">Creating Your Dubbed Video</h3>
                  <p className="text-gray-400 text-sm">This takes a few minutes — hang tight</p>
                </div>

                <div className="space-y-3">
                  {STEPS.map((step, idx) => {
                    const isDone    = currentStepIndex > idx;
                    const isActive  = currentStepIndex === idx;
                    const isPending = currentStepIndex < idx;

                    return (
                      <div
                        key={step.key}
                        className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-500 ${
                          isActive  ? 'bg-purple-500/20 border border-purple-400/40' :
                          isDone    ? 'opacity-60' : 'opacity-30'
                        }`}
                      >
                        {isDone ? (
                          <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                        ) : isActive ? (
                          <Loader2 className="w-4 h-4 text-purple-400 animate-spin flex-shrink-0" />
                        ) : (
                          <div className="w-4 h-4 rounded-full border border-gray-500 flex-shrink-0" />
                        )}
                        <span className={`text-sm ${isActive ? 'text-white font-medium' : 'text-gray-400'}`}>
                          {step.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Results */
          <div className="max-w-4xl mx-auto">
            <div className="backdrop-blur-xl bg-white/10 rounded-3xl p-8 shadow-2xl border border-white/20">
              <div className="flex items-center gap-3 mb-6 p-4 bg-green-500/20 border border-green-500/30 rounded-2xl">
                <CheckCircle className="w-6 h-6 text-green-400 flex-shrink-0" />
                <div>
                  <h3 className="text-green-300 font-semibold">Success!</h3>
                  <p className="text-green-200 text-sm">Your video has been dubbed successfully.</p>
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                <div className="bg-white/5 rounded-2xl p-4 border border-white/10">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-blue-500/20 rounded-xl flex items-center justify-center">
                      <span className="text-blue-400 text-lg">📝</span>
                    </div>
                    <div>
                      <p className="text-white font-semibold">{result.transcriptSegments}</p>
                      <p className="text-gray-400 text-sm">Transcript Segments</p>
                    </div>
                  </div>
                </div>
                <div className="bg-white/5 rounded-2xl p-4 border border-white/10">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-red-500/20 rounded-xl flex items-center justify-center">
                      <span className="text-red-400 text-lg">⚠️</span>
                    </div>
                    <div>
                      <p className="text-white font-semibold">{result.translationErrors}</p>
                      <p className="text-gray-400 text-sm">Translation Errors</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Video Player */}
              <div className="mb-6">
                <h3 className="text-xl font-semibold text-white mb-4">🎬 Your Dubbed Video</h3>
                <p className="text-gray-400 text-xs mb-3">⏱ Available for 1 hour — download to keep it</p>
                <div className="bg-black/50 rounded-2xl overflow-hidden border border-white/10">
                  <video
                    controls
                    className="w-full h-auto max-h-96"
                    src={`${API_URL}${result.downloadUrl}`}
                  >
                    Your browser does not support the video tag.
                  </video>
                </div>
              </div>

              {/* Transcript Viewer */}
              {transcript.length > 0 && (
                <div className="mb-6">
                  <button
                    onClick={() => setShowTranscript(!showTranscript)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl text-white transition-all duration-200"
                  >
                    <span className="font-medium text-sm">📝 View Transcript & Translation</span>
                    {showTranscript ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                  </button>

                  {showTranscript && (
                    <div className="mt-2 rounded-2xl border border-white/10 overflow-hidden">
                      {/* Header */}
                      <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-white/5 border-b border-white/10 text-xs font-semibold text-gray-400 uppercase tracking-wide">
                        <div className="col-span-1">Time</div>
                        <div className="col-span-5">Original</div>
                        <div className="col-span-6">Translation</div>
                      </div>
                      {/* Rows */}
                      <div className="max-h-80 overflow-y-auto">
                        {transcript.map((seg, i) => {
                          const failed = seg.text.trim() === seg.translatedText?.trim();
                          return (
                            <div
                              key={i}
                              className={`grid grid-cols-12 gap-2 px-4 py-2 border-b border-white/5 text-sm ${
                                failed ? 'bg-red-500/10' : 'hover:bg-white/5'
                              }`}
                            >
                              <div className="col-span-1 text-gray-500 text-xs pt-0.5 tabular-nums">
                                {formatTime(seg.start)}
                              </div>
                              <div className="col-span-5 text-gray-300">{seg.text}</div>
                              <div className={`col-span-6 ${failed ? 'text-red-400 italic' : 'text-white'}`}>
                                {seg.translatedText || <span className="text-gray-500">—</span>}
                                {failed && <span className="ml-2 text-xs text-red-500">(not translated)</span>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-col sm:flex-row gap-4">
                <button
                  onClick={handleDownload}
                  className="flex-1 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white font-semibold py-3 px-6 rounded-2xl transition-all duration-300 transform hover:scale-105 shadow-xl flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  Download Video
                </button>
                <button
                  onClick={resetForm}
                  className="flex-1 bg-white/10 hover:bg-white/20 text-white font-semibold py-3 px-6 rounded-2xl transition-all duration-300 border border-white/20 flex items-center justify-center gap-2"
                >
                  <Zap className="w-5 h-5" />
                  Dub Another Video
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="text-center mt-12">
          <p className="text-gray-400 text-sm">
            Powered by AI • Made with ❤️ for content creators
          </p>
        </div>
      </div>
    </div>
  );
}
