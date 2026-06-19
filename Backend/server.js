require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
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

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'google-translator9.p.rapidapi.com';

let translatorAvailable = false;
if (RAPIDAPI_KEY) {
    translatorAvailable = true;
    console.log('✅ RapidAPI Translator initialized');
} else {
    console.error('❌ RapidAPI key not found. Please set RAPIDAPI_KEY in your environment variables');
}

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

// Google Translate distinguishes zh-CN / zh-TW
const RAPIDAPI_LANGUAGE_CODES = {
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

const SUPPORTED_LANGUAGES = new Set(Object.keys(RAPIDAPI_LANGUAGE_CODES));

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
    try {
        if (!translatorAvailable) {
            throw new Error('RapidAPI Translator not initialized. Please check your API key.');
        }

        if (!text || text.trim().length < 2) {
            return text;
        }

        const targetLangCode = RAPIDAPI_LANGUAGE_CODES[targetLanguage.toLowerCase()] || targetLanguage.toLowerCase();

        const response = await axios.request({
            method: 'POST',
            url: 'https://google-translator9.p.rapidapi.com/v2',
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': RAPIDAPI_HOST,
                'Content-Type': 'application/json'
            },
            data: {
                q: text.trim(),
                source: 'auto',
                target: targetLangCode,
                format: 'text'
            },
            timeout: 10000
        });

        if (response.data?.data?.translations?.length > 0) {
            return response.data.data.translations[0].translatedText || text;
        }

        console.warn('Unexpected response format from RapidAPI, using original text');
        return text;

    } catch (error) {
        console.error('RapidAPI Translation error:', error.message);

        if (error.response) {
            const status = error.response.status;
            if (status === 401) throw new Error('Invalid RapidAPI key. Please check your credentials.');
            if (status === 429) throw new Error('RapidAPI rate limit exceeded. Please check your subscription plan.');
            if (status === 403) throw new Error('RapidAPI access forbidden. Please check your subscription and permissions.');
        }

        return text;
    }
};

const batchTranslateText = async (textArray, targetLanguage, batchSize = 10) => {
    try {
        if (!translatorAvailable) {
            throw new Error('RapidAPI Translator not initialized. Please check your API key.');
        }

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
                if (err) {
                    console.error('gTTS error:', err);
                    reject(err);
                } else {
                    resolve(outputPath);
                }
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
            .on('end', () => {
                console.log(`Created silence: ${safeDuration}s -> ${outputPath}`);
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error('Silence creation error:', err);
                reject(err);
            })
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
            .on('error', (err) => {
                console.error('FFmpeg concatenation error:', err);
                reject(err);
            })
            .run();
    });
};

const downloadVideoOnly = async (videoId, outputPath) => {
    try {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const command = `yt-dlp -f "bestvideo[ext=mp4]" --no-audio -o "${outputPath}" "${videoUrl}"`;

        console.log('Executing:', command);
        const { stderr } = await execAsync(command);

        if (stderr && !stderr.includes('WARNING')) {
            console.error('yt-dlp stderr:', stderr);
        }

        await fs.access(outputPath);
        return outputPath;
    } catch (error) {
        console.error('yt-dlp error:', error);

        // Fallback: try with a different format selector
        try {
            const fallbackCommand = `yt-dlp -f "best[ext=mp4]" --no-audio -o "${outputPath}" "https://www.youtube.com/watch?v=${videoId}"`;
            console.log('Trying fallback:', fallbackCommand);
            await execAsync(fallbackCommand);
            await fs.access(outputPath);
            return outputPath;
        } catch (fallbackError) {
            throw new Error(`Failed to download video: ${error.message}. Fallback also failed: ${fallbackError.message}`);
        }
    }
};

const downloadVideoWithYoutubeDl = async (videoId, outputPath) => {
    try {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const command = `youtube-dl -f "bestvideo[ext=mp4]" --no-audio -o "${outputPath}" "${videoUrl}"`;

        console.log('Executing youtube-dl:', command);
        await execAsync(command);
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
            .outputOptions(['-c:v', 'copy', '-c:a', 'aac', '-strict', 'experimental', '-shortest'])
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
};

// Delete intermediate files from the temp dir, keeping only the final video
const cleanupTempFiles = async (tempDir, keepFile) => {
    try {
        const files = await fs.readdir(tempDir);
        await Promise.all(
            files
                .filter(f => path.join(tempDir, f) !== keepFile)
                .map(f => fs.unlink(path.join(tempDir, f)).catch(() => {}))
        );
        console.log('🧹 Temp files cleaned up');
    } catch (err) {
        console.warn('Cleanup warning:', err.message);
    }
};

app.post('/api/check-transcript', async (req, res) => {
    const { videoUrl } = req.body;

    try {
        const videoId = extractVideoId(videoUrl);
        if (!videoId) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        console.log(`🔍 Checking transcript for video: ${videoId}`);
        const result = await validateTranscriptAvailability(videoId);
        res.json(result);
    } catch (error) {
        console.error('Error checking transcript:', error);
        res.status(500).json({
            error: 'Failed to check transcript availability',
            details: error.message
        });
    }
});

app.post('/api/dub-video', async (req, res) => {
    const { videoUrl, targetLanguage } = req.body;
    const jobId = uuidv4();

    try {
        await ensureDownloadsDir();

        console.log('🎬 Starting dubbing process...');

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

        console.log('📹 Video ID extracted:', videoId);
        console.log('📝 Fetching transcript with enhanced reliability...');

        let transcript;
        try {
            transcript = await fetchTranscript(videoId);
        } catch (transcriptError) {
            console.error('❌ Enhanced transcript fetching failed:', transcriptError.message);
            return res.status(400).json({
                error: 'Transcript fetching failed',
                details: transcriptError.message,
                suggestions: [
                    'Try a different video with manual captions',
                    'Check if the video has auto-generated captions enabled',
                    'Ensure the video is publicly accessible',
                    'Try again in a few minutes - YouTube may be rate limiting'
                ]
            });
        }

        if (!transcript || transcript.length === 0) {
            return res.status(400).json({
                error: 'Empty transcript',
                details: 'The transcript was fetched but contains no content',
                suggestions: ['Try a different video with spoken content and captions']
            });
        }

        console.log(`✅ Successfully fetched ${transcript.length} transcript segments`);
        console.log('Transcript preview:', transcript.slice(0, 3).map(t => t.text).join(' '));

        console.log('🌐 Translating transcript using RapidAPI Google Translator...');

        let translatedTranscript;
        let translationErrors = 0;

        try {
            translatedTranscript = await batchTranslateText(transcript, targetLanguage);
            translationErrors = translatedTranscript.filter(item =>
                item.text === item.translatedText && item.text.trim().length >= 2
            ).length;
            console.log(`✅ Translation completed. ${translationErrors} items unchanged.`);
        } catch (translateError) {
            console.error('❌ Batch translation failed:', translateError.message);
            translatedTranscript = transcript.map(item => ({ ...item, translatedText: item.text }));
            translationErrors = transcript.length;
        }

        if (translationErrors > 0) {
            console.warn(`⚠️ ${translationErrors} translation issues occurred. Some text may be in original language.`);
        }

        console.log('🔊 Generating audio clips...');
        const audioClips = [];
        const tempDir = path.join(__dirname, 'downloads', jobId);
        await fs.mkdir(tempDir, { recursive: true });

        let successfulClips = 0;

        for (let i = 0; i < translatedTranscript.length; i++) {
            const item = translatedTranscript[i];

            if (!item.translatedText || item.translatedText.trim().length < 2) {
                console.log(`Skipping empty/short text at line ${i}`);
                continue;
            }

            const audioPath = path.join(tempDir, `line_${i}.wav`);

            try {
                await generateAudio(item.translatedText, targetLanguage, audioPath);
                audioClips.push({ path: audioPath, start: item.start, duration: item.duration, index: i });
                successfulClips++;
                console.log(`Generated audio ${successfulClips}/${translatedTranscript.length}`);
            } catch (audioError) {
                console.error(`Error generating audio for line ${i}:`, audioError.message);
                try {
                    const silenceDuration = Math.max(item.duration, 0.5);
                    const silencePath = path.join(tempDir, `silence_${i}.wav`);
                    await createSilence(silenceDuration, silencePath);
                    audioClips.push({ path: silencePath, start: item.start, duration: silenceDuration, index: i });
                    successfulClips++;
                } catch (silenceError) {
                    console.error(`Failed to create silence for line ${i}:`, silenceError.message);
                }
            }
        }

        if (audioClips.length === 0) {
            throw new Error('No audio clips were generated successfully. Please check the transcript and try again.');
        }

        console.log(`Successfully generated ${audioClips.length} audio clips`);

        console.log('⏰ Aligning audio with timestamps...');
        const alignedAudioFiles = [];

        audioClips.sort((a, b) => a.start - b.start);

        let currentTime = 0;

        for (let i = 0; i < audioClips.length; i++) {
            const clip = audioClips[i];

            if (clip.start > currentTime) {
                const silenceDuration = clip.start - currentTime;
                if (silenceDuration > 0.1) {
                    const silencePath = path.join(tempDir, `gap_${i}.wav`);
                    try {
                        await createSilence(silenceDuration, silencePath);
                        alignedAudioFiles.push(silencePath);
                    } catch (silenceError) {
                        console.error('Failed to create gap silence:', silenceError.message);
                    }
                }
            }

            alignedAudioFiles.push(clip.path);
            currentTime = clip.start + clip.duration;
        }

        if (alignedAudioFiles.length === 0) {
            throw new Error('No aligned audio files were created. Audio generation failed.');
        }

        console.log('🔗 Concatenating audio clips...');
        const finalAudioPath = path.join(tempDir, 'final_audio.wav');

        try {
            await concatenateAudio(alignedAudioFiles, finalAudioPath);
        } catch (concatError) {
            console.error('Concatenation failed, trying alternative method:', concatError.message);
            const totalDuration = Math.max(...audioClips.map(clip => clip.start + clip.duration));
            await createSilence(totalDuration || 10, finalAudioPath);
        }

        console.log('📥 Downloading video...');
        const videoPath = path.join(tempDir, 'video.mp4');

        try {
            await downloadVideoOnly(videoId, videoPath);
        } catch (error) {
            console.error('yt-dlp failed, trying youtube-dl:', error.message);
            try {
                await downloadVideoWithYoutubeDl(videoId, videoPath);
            } catch (fallbackError) {
                throw new Error(`Both yt-dlp and youtube-dl failed. Please ensure one of them is installed: ${error.message}`);
            }
        }

        console.log('🎭 Merging video and audio...');
        const finalVideoPath = path.join(tempDir, 'dubbed_video.mp4');
        await mergeVideoAudio(videoPath, finalAudioPath, finalVideoPath);

        await cleanupTempFiles(tempDir, finalVideoPath);

        console.log('✅ Dubbing completed successfully!');

        res.json({
            success: true,
            jobId,
            downloadUrl: `/downloads/${jobId}/dubbed_video.mp4`,
            message: 'Video dubbed successfully using RapidAPI Google Translator!',
            transcriptSegments: transcript.length,
            translationErrors
        });

    } catch (error) {
        console.error('❌ Error during dubbing process:', error);
        res.status(500).json({
            error: 'Failed to dub video',
            details: error.message
        });
    }
});

app.get('/api/job-status/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const finalVideo = path.join(__dirname, 'downloads', jobId, 'dubbed_video.mp4');

    try {
        await fs.access(finalVideo);
        res.json({ status: 'completed', downloadUrl: `/downloads/${jobId}/dubbed_video.mp4` });
    } catch {
        res.json({ status: 'processing' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        message: 'YouTube Dubbing API is running',
        translateStatus: translatorAvailable ? 'RapidAPI Connected' : 'Not Connected'
    });
});

app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
});

app.listen(PORT, () => {
    console.log(`🚀 YouTube Dubbing API server running on port ${PORT}`);
    console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🔑 RapidAPI Translator Status: ${translatorAvailable ? '✅ Connected' : '❌ Not Connected'}`);
});

module.exports = app;
