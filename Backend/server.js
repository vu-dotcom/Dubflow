require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
const axios = require('axios');
const gTTS = require('gtts');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { promisify } = require('util');

const { fetchTranscript, validateTranscriptAvailability } = require('./transcript-fetcher');

const app = express();
const PORT = process.env.PORT || 3001;
const execAsync = promisify(exec);

app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

console.log('✅ MyMemory Translator ready (no API key required)');

// Shared language name → code mappings
const BASE_LANGUAGE_CODES = {
    'spanish': 'es', 'french': 'fr', 'german': 'de', 'italian': 'it',
    'portuguese': 'pt', 'russian': 'ru', 'japanese': 'ja', 'korean': 'ko',
    'hindi': 'hi', 'arabic': 'ar', 'dutch': 'nl', 'polish': 'pl',
    'turkish': 'tr', 'swedish': 'sv', 'norwegian': 'no', 'danish': 'da',
    'finnish': 'fi', 'greek': 'el', 'hebrew': 'he', 'thai': 'th',
    'vietnamese': 'vi', 'indonesian': 'id', 'malay': 'ms', 'tagalog': 'tl',
    'urdu': 'ur', 'bengali': 'bn', 'tamil': 'ta', 'telugu': 'te',
    'marathi': 'mr', 'gujarati': 'gu', 'kannada': 'kn', 'malayalam': 'ml',
    'punjabi': 'pa'
};

// MyMemory uses zh-CN / zh-TW for Chinese variants
const TRANSLATION_LANGUAGE_CODES = {
    ...BASE_LANGUAGE_CODES,
    'chinese': 'zh-CN',
    'chinese simplified': 'zh-CN',
    'chinese traditional': 'zh-TW'
};

// gTTS uses 'zh' for all Chinese variants
const GTTS_LANGUAGE_CODES = {
    ...BASE_LANGUAGE_CODES,
    'chinese': 'zh'
};

const SUPPORTED_LANGUAGES = new Set(Object.keys(TRANSLATION_LANGUAGE_CODES));

// In-memory job store — each entry: { status, step, downloadUrl?, error?, transcriptSegments?, translationErrors?, tempDir }
const jobs = new Map();

const updateJob = (jobId, update) => {
    const job = jobs.get(jobId);
    if (job) jobs.set(jobId, { ...job, ...update });
};

// Delete job files after TTL; remove the entry from memory after failed jobs
const scheduleJobCleanup = (jobId, tempDir, delayMs = 60 * 60 * 1000) => {
    setTimeout(async () => {
        try {
            await fs.rm(tempDir, { recursive: true, force: true });
            jobs.delete(jobId);
            console.log(`🗑️  Cleaned up job ${jobId}`);
        } catch (err) {
            console.warn(`Cleanup failed for job ${jobId}:`, err.message);
        }
    }, delayMs);
};

const ensureDownloadsDir = async () => {
    const downloadsDir = path.join(__dirname, 'downloads');
    try {
        await fs.access(downloadsDir);
    } catch {
        await fs.mkdir(downloadsDir, { recursive: true });
    }
};

const extractVideoId = (url) => {
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
};

const translateText = async (text, targetLanguage) => {
    if (!text || text.trim().length < 2) return text;

    const targetLangCode = TRANSLATION_LANGUAGE_CODES[targetLanguage.toLowerCase()] || targetLanguage.toLowerCase();

    try {
        const response = await axios.get('https://api.mymemory.translated.net/get', {
            params: {
                q: text.trim(),
                langpair: `en|${targetLangCode}`
            },
            timeout: 10000
        });

        const translated = response.data?.responseData?.translatedText;
        if (translated && response.data?.responseStatus === 200) {
            return translated;
        }

        // Quota exceeded
        if (response.data?.quotaFinished) {
            throw new Error('MyMemory daily quota exceeded. Try again tomorrow or register a free email at mymemory.translated.net for a higher limit.');
        }

        console.warn('Unexpected MyMemory response, using original text');
        return text;

    } catch (error) {
        if (error.message.includes('quota')) throw error;
        console.error('Translation error:', error.message);
        return text;
    }
};

const batchTranslateText = async (textArray, targetLanguage, batchSize = 10) => {
    try {
        const results = [];

        for (let i = 0; i < textArray.length; i += batchSize) {
            const batch = textArray.slice(i, i + batchSize);
            console.log(`🌐 Processing translation batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(textArray.length / batchSize)}`);

            for (const item of batch) {
                if (!item.text || item.text.trim().length < 2) {
                    results.push({ ...item, translatedText: item.text });
                    continue;
                }

                try {
                    const translatedText = await translateText(item.text, targetLanguage);
                    results.push({ ...item, translatedText });
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (itemError) {
                    console.error(`Translation failed for item: "${item.text.substring(0, 50)}..."`, itemError.message);
                    results.push({ ...item, translatedText: item.text });
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            if (i + batchSize < textArray.length) {
                const delayTime = Math.random() * 2000 + 3000;
                console.log(`⏳ Waiting ${Math.round(delayTime / 1000)}s before next batch to avoid rate limiting...`);
                await new Promise(resolve => setTimeout(resolve, delayTime));
            }
        }

        return results;
    } catch (error) {
        console.error('Batch translation error:', error.message);
        return textArray.map(item => ({ ...item, translatedText: item.text }));
    }
};

const generateAudio = async (text, language, outputPath) => {
    return new Promise((resolve, reject) => {
        if (!text || text.trim().length < 2) {
            return reject(new Error('Text too short for TTS'));
        }

        const langCode = GTTS_LANGUAGE_CODES[language.toLowerCase()] || 'en';

        try {
            const gtts = new gTTS(text.trim(), langCode);
            gtts.save(outputPath, (err) => {
                if (err) { console.error('gTTS error:', err); reject(err); }
                else resolve(outputPath);
            });
        } catch (error) {
            console.error('gTTS creation error:', error);
            reject(error);
        }
    });
};

const createSilence = async (duration, outputPath) => {
    return new Promise((resolve, reject) => {
        const safeDuration = Math.max(0.1, Math.min(duration, 3600));

        ffmpeg()
            .input('anullsrc=channel_layout=stereo:sample_rate=22050')
            .inputFormat('lavfi')
            .duration(safeDuration)
            .audioCodec('pcm_s16le')
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => { console.error('Silence creation error:', err); reject(err); })
            .run();
    });
};

const concatenateAudio = async (audioFiles, outputPath) => {
    return new Promise((resolve, reject) => {
        if (!audioFiles || audioFiles.length === 0) {
            return reject(new Error('No audio files to concatenate'));
        }

        if (audioFiles.length === 1) {
            ffmpeg(audioFiles[0])
                .output(outputPath)
                .on('end', () => resolve(outputPath))
                .on('error', reject)
                .run();
            return;
        }

        const command = ffmpeg();
        audioFiles.forEach(file => command.input(file));

        const filterComplex = audioFiles.map((_, index) => `[${index}:0]`).join('') +
            `concat=n=${audioFiles.length}:v=0:a=1[out]`;

        command
            .complexFilter(filterComplex)
            .outputOptions(['-map', '[out]'])
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => { console.error('FFmpeg concatenation error:', err); reject(err); })
            .run();
    });
};

const downloadVideoOnly = async (videoId, outputPath) => {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    try {
        const { stderr } = await execAsync(
            `python3 -m yt_dlp --extractor-args "youtube:player_client=android" -f "bestvideo[ext=mp4]/best[ext=mp4]/best" --socket-timeout 30 -o "${outputPath}" "${videoUrl}"`
        );
        if (stderr && !stderr.includes('WARNING')) console.error('yt-dlp stderr:', stderr);
        await fs.access(outputPath);
        return outputPath;
    } catch (error) {
        console.error('yt-dlp error:', error);
        // Fallback: any available format
        try {
            await execAsync(
                `python3 -m yt_dlp --extractor-args "youtube:player_client=android" -f "mp4/best" --socket-timeout 30 -o "${outputPath}" "${videoUrl}"`
            );
            await fs.access(outputPath);
            return outputPath;
        } catch (fallbackError) {
            throw new Error(`Failed to download video: ${error.message}. Fallback also failed: ${fallbackError.message}`);
        }
    }
};

const downloadVideoWithYoutubeDl = async (videoId, outputPath) => {
    try {
        await execAsync(
            `youtube-dl -f "bestvideo[ext=mp4]" --no-audio -o "${outputPath}" "https://www.youtube.com/watch?v=${videoId}"`
        );
        await fs.access(outputPath);
        return outputPath;
    } catch (error) {
        throw new Error(`youtube-dl failed: ${error.message}`);
    }
};

const mergeVideoAudio = async (videoPath, audioPath, outputPath) => {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(videoPath)
            .input(audioPath)
            .outputOptions(['-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-strict', 'experimental', '-shortest'])
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
};

// Delete everything in tempDir except keepFile
const cleanupTempFiles = async (tempDir, keepFile) => {
    try {
        const files = await fs.readdir(tempDir);
        await Promise.all(
            files
                .filter(f => path.join(tempDir, f) !== keepFile)
                .map(f => fs.unlink(path.join(tempDir, f)).catch(() => {}))
        );
        console.log('🧹 Intermediate files cleaned up');
    } catch (err) {
        console.warn('Cleanup warning:', err.message);
    }
};

// Background dubbing pipeline — updates job store at each step
const runDubbingJob = async (jobId, videoId, targetLanguage) => {
    const tempDir = path.join(__dirname, 'downloads', jobId);

    try {
        await fs.mkdir(tempDir, { recursive: true });

        // Step 1: Fetch transcript
        updateJob(jobId, { step: 'fetching_transcript' });
        console.log(`[${jobId}] 📝 Fetching transcript...`);

        let transcript;
        try {
            transcript = await fetchTranscript(videoId);
        } catch (transcriptError) {
            updateJob(jobId, { status: 'failed', error: transcriptError.message });
            scheduleJobCleanup(jobId, tempDir, 5 * 60 * 1000);
            return;
        }

        if (!transcript || transcript.length === 0) {
            updateJob(jobId, { status: 'failed', error: 'The transcript was fetched but contains no content.' });
            scheduleJobCleanup(jobId, tempDir, 5 * 60 * 1000);
            return;
        }

        console.log(`[${jobId}] ✅ Fetched ${transcript.length} transcript segments`);

        // Step 2: Translate
        updateJob(jobId, { step: 'translating' });
        console.log(`[${jobId}] 🌐 Translating...`);

        let translatedTranscript;
        let translationErrors = 0;

        try {
            translatedTranscript = await batchTranslateText(transcript, targetLanguage);
            translationErrors = translatedTranscript.filter(item =>
                item.text === item.translatedText && item.text.trim().length >= 2
            ).length;
        } catch {
            translatedTranscript = transcript.map(item => ({ ...item, translatedText: item.text }));
            translationErrors = transcript.length;
        }

        // Step 3: Generate audio clips
        updateJob(jobId, { step: 'generating_audio' });
        console.log(`[${jobId}] 🔊 Generating audio...`);

        const audioClips = [];

        for (let i = 0; i < translatedTranscript.length; i++) {
            const item = translatedTranscript[i];

            if (!item.translatedText || item.translatedText.trim().length < 2) continue;

            const audioPath = path.join(tempDir, `line_${i}.wav`);

            try {
                await generateAudio(item.translatedText, targetLanguage, audioPath);
                audioClips.push({ path: audioPath, start: item.start, duration: item.duration, index: i });
            } catch {
                // Fallback to silence for this segment
                try {
                    const silencePath = path.join(tempDir, `silence_${i}.wav`);
                    await createSilence(Math.max(item.duration, 0.5), silencePath);
                    audioClips.push({ path: silencePath, start: item.start, duration: item.duration, index: i });
                } catch (silenceError) {
                    console.error(`[${jobId}] Failed to create silence for line ${i}:`, silenceError.message);
                }
            }
        }

        if (audioClips.length === 0) {
            updateJob(jobId, { status: 'failed', error: 'No audio clips could be generated.' });
            scheduleJobCleanup(jobId, tempDir, 5 * 60 * 1000);
            return;
        }

        // Build aligned audio track
        audioClips.sort((a, b) => a.start - b.start);
        const alignedAudioFiles = [];
        let currentTime = 0;

        for (let i = 0; i < audioClips.length; i++) {
            const clip = audioClips[i];

            if (clip.start > currentTime + 0.1) {
                const silencePath = path.join(tempDir, `gap_${i}.wav`);
                try {
                    await createSilence(clip.start - currentTime, silencePath);
                    alignedAudioFiles.push(silencePath);
                } catch { /* skip gap */ }
            }

            alignedAudioFiles.push(clip.path);
            currentTime = clip.start + clip.duration;
        }

        const finalAudioPath = path.join(tempDir, 'final_audio.wav');

        try {
            await concatenateAudio(alignedAudioFiles, finalAudioPath);
        } catch (concatError) {
            console.error(`[${jobId}] Concatenation failed, using silence fallback:`, concatError.message);
            const totalDuration = Math.max(...audioClips.map(c => c.start + c.duration));
            await createSilence(totalDuration || 10, finalAudioPath);
        }

        // Step 4: Download video
        updateJob(jobId, { step: 'downloading_video' });
        console.log(`[${jobId}] 📥 Downloading video...`);

        const videoPath = path.join(tempDir, 'video.mp4');

        try {
            await downloadVideoOnly(videoId, videoPath);
        } catch (dlError) {
            console.error(`[${jobId}] yt-dlp failed, trying youtube-dl:`, dlError.message);
            try {
                await downloadVideoWithYoutubeDl(videoId, videoPath);
            } catch (fallbackError) {
                updateJob(jobId, {
                    status: 'failed',
                    error: `Video download failed: ${dlError.message}`
                });
                scheduleJobCleanup(jobId, tempDir, 5 * 60 * 1000);
                return;
            }
        }

        // Step 5: Merge
        updateJob(jobId, { step: 'merging' });
        console.log(`[${jobId}] 🎭 Merging video and audio...`);

        const finalVideoPath = path.join(tempDir, 'dubbed_video.mp4');
        await mergeVideoAudio(videoPath, finalAudioPath, finalVideoPath);

        // Clean up intermediate files, keep only dubbed_video.mp4
        await cleanupTempFiles(tempDir, finalVideoPath);

        // Schedule full directory cleanup after 1 hour
        scheduleJobCleanup(jobId, tempDir, 60 * 60 * 1000);

        updateJob(jobId, {
            status: 'completed',
            step: 'completed',
            downloadUrl: `/downloads/${jobId}/dubbed_video.mp4`,
            transcriptSegments: transcript.length,
            translationErrors
        });

        console.log(`[${jobId}] ✅ Dubbing completed!`);

    } catch (error) {
        console.error(`[${jobId}] ❌ Unhandled error:`, error);
        updateJob(jobId, { status: 'failed', error: error.message });
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        // Keep the failed entry for 5 minutes so the frontend can read the error
        setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
    }
};

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/api/check-transcript', async (req, res) => {
    const { videoUrl } = req.body;
    try {
        const videoId = extractVideoId(videoUrl);
        if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

        console.log(`🔍 Checking transcript for video: ${videoId}`);
        const result = await validateTranscriptAvailability(videoId);
        res.json(result);
    } catch (error) {
        console.error('Error checking transcript:', error);
        res.status(500).json({ error: 'Failed to check transcript availability', details: error.message });
    }
});

// Returns immediately with jobId; processing runs in the background
app.post('/api/dub-video', async (req, res) => {
    const { videoUrl, targetLanguage } = req.body;

    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    if (!targetLanguage || !SUPPORTED_LANGUAGES.has(targetLanguage.toLowerCase())) {
        return res.status(400).json({
            error: `Unsupported language: "${targetLanguage}"`,
            supported: [...SUPPORTED_LANGUAGES]
        });
    }

    const jobId = uuidv4();
    jobs.set(jobId, { status: 'processing', step: 'fetching_transcript', tempDir: path.join(__dirname, 'downloads', jobId) });

    runDubbingJob(jobId, videoId, targetLanguage).catch(err => {
        console.error('Unhandled job error:', err);
        updateJob(jobId, { status: 'failed', error: err.message });
    });

    res.json({ jobId });
});

// Poll this to track progress
app.get('/api/job-status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found or already expired' });
    }

    // Don't expose internal tempDir to the client
    const { tempDir, ...clientJob } = job;
    res.json(clientJob);
});

// Serves the file with Content-Disposition: attachment so browsers download instead of open
app.get('/api/download/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const finalVideo = path.join(__dirname, 'downloads', jobId, 'dubbed_video.mp4');

    try {
        await fs.access(finalVideo);
        res.setHeader('Content-Disposition', 'attachment; filename="dubbed_video.mp4"');
        res.setHeader('Content-Type', 'video/mp4');
        res.sendFile(finalVideo);
    } catch {
        res.status(404).json({ error: 'File not found or already cleaned up' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        message: 'YouTube Dubbing API is running',
        translateStatus: 'MyMemory (free, no key required)',
        activeJobs: jobs.size
    });
});

app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
});

ensureDownloadsDir().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 YouTube Dubbing API server running on port ${PORT}`);
        console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
        console.log(`🌐 Translation: MyMemory (free, no API key required)`);
    });
});

module.exports = app;
