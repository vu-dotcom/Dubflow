const { YoutubeTranscript } = require('youtube-transcript');

const RETRY_CONFIG = {
    maxRetries: 5,
    baseDelay: 1000,
    maxDelay: 10000,
    backoffFactor: 2
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const calculateRetryDelay = (attempt) => {
    const delay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffFactor, attempt);
    return Math.min(delay, RETRY_CONFIG.maxDelay);
};

const fetchTranscriptWithRetry = async (videoId, maxRetries = RETRY_CONFIG.maxRetries) => {
    console.log(`📝 Attempting to fetch transcript for video: ${videoId}`);
    let lastError = null;
    const languageCodes = ['en', 'en-US', 'en-GB', null];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        console.log(`Attempt ${attempt + 1}/${maxRetries}`);
        for (const langCode of languageCodes) {
            try {
                console.log(`Trying ${langCode ? `language: ${langCode}` : 'auto-detect'}`);
                const config = langCode ? { lang: langCode } : {};
                const transcript = await YoutubeTranscript.fetchTranscript(videoId, config);
                if (transcript && transcript.length > 0) {
                    console.log(`✅ Successfully fetched transcript with ${transcript.length} segments`);
                    return transcript.map(item => ({
                        text: item.text,
                        start: item.offset !== undefined ? parseFloat(item.offset) / 1000 : parseFloat(item.start),
                        duration: item.offset !== undefined ? parseFloat(item.duration) / 1000 : parseFloat(item.duration)
                    }));
                }
            } catch (error) {
                lastError = error;
                console.log(`Failed with ${langCode || 'auto-detect'}: ${error.message}`);
                if (error.message.includes('transcript') || error.message.includes('captions')) continue;
                break;
            }
        }
        if (attempt < maxRetries - 1) {
            const delay = calculateRetryDelay(attempt);
            console.log(`⏳ Waiting ${delay}ms before retry...`);
            await sleep(delay);
        }
    }
    throw new Error(`Failed to fetch transcript after ${maxRetries} attempts. Last error: ${lastError?.message || 'Unknown error'}.`);
};

const fetchTranscript = async (videoId) => {
    try {
        if (!videoId || typeof videoId !== 'string' || videoId.length !== 11) {
            throw new Error('Invalid YouTube video ID format');
        }
        return await fetchTranscriptWithRetry(videoId);
    } catch (error) {
        console.error('❌ Transcript fetching failed:', error.message);
        if (error.message.includes('Private video')) throw new Error('This video is private.');
        else if (error.message.includes('Video unavailable')) throw new Error('This video is unavailable.');
        else if (error.message.includes('transcript') || error.message.includes('captions')) {
            throw new Error('No transcript/captions found for this video. Please ensure the video has captions enabled.');
        } else throw error;
    }
};

const validateTranscriptAvailability = async (videoId) => {
    try {
        const transcript = await fetchTranscript(videoId);
        return { available: true, segmentCount: transcript.length };
    } catch (error) {
        return { available: false, error: error.message };
    }
};

module.exports = { fetchTranscript, fetchTranscriptWithRetry, validateTranscriptAvailability, RETRY_CONFIG };
