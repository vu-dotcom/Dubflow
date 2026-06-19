require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
const axios = require('axios');
const deepl = require('deepl-node');
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

// DeepL target language codes — null means DeepL doesn't support it (TTS still works, no translation)
const DEEPL_LANGUAGE_CODES = {
    'spanish':    'ES',    'french':     'FR',   'german':    'DE',
    'italian':    'IT',    'portuguese': 'PT-BR', 'russian':   'RU',
    'japanese':   'JA',    'korean':     'KO',   'arabic':    'AR',
    'dutch':      'NL',    'polish':     'PL',   'turkish':   'TR',
    'swedish':    'SV',    'norwegian':  'NB',   'danish':    'DA',
    'finnish':    'FI',    'greek':      'EL',   'indonesian':'ID',
    'romanian':   'RO',    'ukrainian':  'UK',   'bulgarian': 'BG',
    'czech':      'CS',    'hungarian':  'HU',   'slovak':    'SK',
    'slovenian':  'SL',    'estonian':   'ET',   'latvian':   'LV',
    'lithuanian': 'LT',
    'chinese': 'ZH', 'chinese simplified': 'ZH', 'chinese traditional': 'ZH',
    // Languages not yet in DeepL — TTS-only (no translation)
    'hindi': null, 'hebrew': null, 'thai': null, 'vietnamese': null,
    'malay': null, 'tagalog': null, 'urdu': null, 'bengali': null,
    'tamil': null, 'telugu': null, 'marathi': null, 'gujarati': null,
    'kannada': null, 'malayalam': null, 'punjabi': null,
};

let deeplTranslator = null;
if (process.env.DEEPL_API_KEY) {
    deeplTranslator = new deepl.Translator(process.env.DEEPL_API_KEY);
    console.log('✅ DeepL translator ready');
} else {
    console.warn('⚠️  DEEPL_API_KEY not set — translation will be skipped (add to .env)');
}

// Edge TTS voice map — Microsoft Azure Neural voices, free via edge-tts
const EDGE_TTS_VOICES = {
    'spanish':    'es-ES-AlvaroNeural',
    'french':     'fr-FR-HenriNeural',
    'german':     'de-DE-ConradNeural',
    'italian':    'it-IT-DiegoNeural',
    'portuguese': 'pt-BR-AntonioNeural',
    'russian':    'ru-RU-DmitryNeural',
    'japanese':   'ja-JP-KeitaNeural',
    'korean':     'ko-KR-InJoonNeural',
    'chinese':    'zh-CN-YunxiNeural',
    'chinese simplified':  'zh-CN-YunxiNeural',
    'chinese traditional': 'zh-TW-YunJheNeural',
    'hindi':      'hi-IN-MadhurNeural',
    'arabic':     'ar-SA-HamedNeural',
    'dutch':      'nl-NL-MaartenNeural',
    'polish':     'pl-PL-MarekNeural',
    'turkish':    'tr-TR-AhmetNeural',
    'swedish':    'sv-SE-MattiasNeural',
    'norwegian':  'nb-NO-FinnNeural',
    'danish':     'da-DK-JeppeNeural',
    'finnish':    'fi-FI-HarriNeural',
    'greek':      'el-GR-NestorasNeural',
    'hebrew':     'he-IL-AvriNeural',
    'thai':       'th-TH-NiwatNeural',
    'vietnamese': 'vi-VN-NamMinhNeural',
    'indonesian': 'id-ID-ArdiNeural',
    'malay':      'ms-MY-OsmanNeural',
    'tagalog':    'fil-PH-AngeloNeural',
    'urdu':       'ur-PK-AsadNeural',
    'bengali':    'bn-IN-BashkarNeural',
    'tamil':      'ta-IN-ValluvarNeural',
    'telugu':     'te-IN-MohanNeural',
    'marathi':    'mr-IN-ManoharNeural',
    'gujarati':   'gu-IN-NiranjanNeural',
    'kannada':    'kn-IN-GaganNeural',
    'malayalam':  'ml-IN-MidhunNeural',
    'punjabi':    'pa-IN-OjasNeural'
};

// Any language with a TTS voice can be dubbed (even without translation support)
const SUPPORTED_LANGUAGES = new Set(Object.keys(EDGE_TTS_VOICES));

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

const batchTranslateText = async (textArray, targetLanguage) => {
    if (!deeplTranslator) {
        console.warn('Translation skipped — DEEPL_API_KEY not configured');
        return textArray.map(item => ({ ...item, translatedText: item.text }));
    }

    const targetLangCode = DEEPL_LANGUAGE_CODES[targetLanguage.toLowerCase()];
    if (!targetLangCode) {
        console.log(`ℹ️  DeepL doesn't support ${targetLanguage} — using original text`);
        return textArray.map(item => ({ ...item, translatedText: item.text }));
    }

    try {
        const texts = textArray.map(item => item.text || '');
        console.log(`🌐 Translating ${texts.length} segments to ${targetLanguage} via DeepL...`);
        const results = await deeplTranslator.translateText(texts, null, targetLangCode);
        console.log('✅ DeepL translation complete');
        return textArray.map((item, i) => ({
            ...item,
            translatedText: results[i]?.text || item.text,
        }));
    } catch (error) {
        if (error.message?.toLowerCase().includes('quota')) {
            console.error('DeepL monthly quota exceeded — using original text');
        } else {
            console.error('DeepL translation error:', error.message);
        }
        return textArray.map(item => ({ ...item, translatedText: item.text }));
    }
};

const generateAudio = async (text, language, outputPath) => {
    if (!text || text.trim().length < 2) {
        throw new Error('Text too short for TTS');
    }

    const voice = EDGE_TTS_VOICES[language.toLowerCase()] || 'en-US-ChristopherNeural';
    const mp3Path = outputPath.replace(/\.wav$/, '.mp3');

    // Write text to a temp file to safely handle special characters
    const textFile = outputPath + '.txt';
    await fs.writeFile(textFile, text.trim(), 'utf8');

    try {
        await execAsync(`python3 "${path.join(__dirname, 'tts_helper.py')}" "${textFile}" "${voice}" "${mp3Path}"`);
        await fs.access(mp3Path);
        return mp3Path;
    } finally {
        await fs.unlink(textFile).catch(() => {});
    }
};

const createSilence = async (duration, outputPath) => {
    return new Promise((resolve, reject) => {
        const safeDuration = Math.max(0.1, Math.min(duration, 3600));
        const mp3Path = outputPath.replace(/\.wav$/, '.mp3');

        ffmpeg()
            .input('anullsrc=channel_layout=stereo:sample_rate=24000')
            .inputFormat('lavfi')
            .duration(safeDuration)
            .audioCodec('libmp3lame')
            .audioBitrate('128k')
            .output(mp3Path)
            .on('end', () => resolve(mp3Path))
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

        // Store transcript data for the viewer endpoint
        updateJob(jobId, { transcriptData: translatedTranscript });

        // Step 3: Generate audio clips
        updateJob(jobId, { step: 'generating_audio' });
        console.log(`[${jobId}] 🔊 Generating audio...`);

        const audioClips = [];

        for (let i = 0; i < translatedTranscript.length; i++) {
            const item = translatedTranscript[i];

            if (!item.translatedText || item.translatedText.trim().length < 2) continue;

            const audioPath = path.join(tempDir, `line_${i}.mp3`);

            try {
                await generateAudio(item.translatedText, targetLanguage, audioPath);
                audioClips.push({ path: audioPath, start: item.start, duration: item.duration, index: i });
            } catch {
                // Fallback to silence for this segment
                try {
                    const silencePath = path.join(tempDir, `silence_${i}.mp3`);
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
                const silencePath = path.join(tempDir, `gap_${i}.mp3`);
                try {
                    await createSilence(clip.start - currentTime, silencePath);
                    alignedAudioFiles.push(silencePath);
                } catch { /* skip gap */ }
            }

            alignedAudioFiles.push(clip.path);
            currentTime = clip.start + clip.duration;
        }

        const finalAudioPath = path.join(tempDir, 'final_audio.mp3');

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

    // Strip internal fields — transcriptData is served by its own endpoint
    const { tempDir, transcriptData, ...clientJob } = job;
    res.json(clientJob);
});

// Returns the original + translated transcript for the viewer
app.get('/api/job-transcript/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) return res.status(404).json({ error: 'Job not found or already expired' });
    if (!job.transcriptData) return res.status(404).json({ error: 'Transcript not yet available' });

    res.json({ segments: job.transcriptData });
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
        translateStatus: deeplTranslator ? 'DeepL (500k chars/month free)' : 'DeepL (DEEPL_API_KEY not set)',
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
        console.log(`🌐 Translation: ${deeplTranslator ? 'DeepL ready' : 'DeepL not configured (add DEEPL_API_KEY to .env)'}`);
    });
});

module.exports = app;
