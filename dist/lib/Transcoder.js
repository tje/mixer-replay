"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = __importDefault(require("events"));
const moment_1 = __importDefault(require("moment"));
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
const axios_1 = __importDefault(require("axios"));
const shortid_1 = __importDefault(require("shortid"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
require('moment-duration-format');
class ReplayBuffer extends events_1.default {
    constructor({ url, startTime, bufferSize, chunkSize, outputPath, prefix, selectStream }) {
        super();
        this.frames = 0;
        this.duration = moment_1.default.duration(0);
        this.currentTime = moment_1.default();
        this.url = url;
        this.startTime = moment_1.default.utc(startTime);
        this.bufferSize = bufferSize;
        this.chunkSize = chunkSize;
        this.outputPath = outputPath;
        this.outputFile = `${prefix}.m3u8`;
        this.prefix = prefix;
        const listSize = bufferSize / chunkSize;
        const fragmentFilename = `${prefix}-fragment-%d.ts`;
        const stream = this.stream = fluent_ffmpeg_1.default();
        stream
            .input(this.url)
            .inputOptions([
            '-f hls',
            '-live_start_index -3',
            '-loglevel verbose'
        ])
            .outputOptions([
            // `-map 0:p:${selectStream}`,
            '-copyts',
            '-vsync 2',
            `-force_key_frames expr:gte(t\,n_forced*${chunkSize})`,
            '-c:v libx264',
            // '-preset ultrafast',
            // '-crf 0',
            '-c:a aac',
            '-f hls',
            `-hls_time ${chunkSize}`,
            `-hls_list_size ${listSize}`,
            `-hls_segment_filename ${path.join(this.outputPath, fragmentFilename)}`,
            `-hls_base_url ${this.outputPath}${path.sep}`,
            '-hls_flags delete_segments'
        ])
            .output(path.join(this.outputPath, this.outputFile))
            // .on('start', cmd => (console.log(cmd), this.emit('startWatching', cmd)))
            .on('start', cmd => this.emit('startWatching', cmd))
            .on('progress', stat => this.update(stat))
            .on('end', () => this.emit('stopWatching'))
            .on('error', (err, stdout, stderr) => this.emit('error', {
            err,
            stdout,
            stderr
        }))
            // .on('stderr', l => console.log(l))
            .run();
    }
    /**
     * Update this instance's progress with process frame count and timecodes
     * @todo Better parameter handling, this is awful
     */
    update({ frames, timemark }) {
        this.frames = frames;
        this.duration = moment_1.default.duration(timemark);
        this.currentTime = this.startTime.clone().add(this.duration);
        // console.log(this.duration.format('HH:mm:ss.sss'), this.latency, this.duration.asMilliseconds())
        this.emit('update', { currentTime: this.currentTime });
    }
    /**
     * Returns a promise that resolves if or when the replay buffer contains the
     * desired timecode.
     * @todo Probably needs some sort of timeout mechanism that rejects
     * @param endTime Moment-wrapped timecode to check for containment
     */
    contains(endTime) {
        return new Promise((resolve, reject) => {
            const observe = () => {
                const duration = Number(this.duration);
                // Wait until we get two extra chunks, just to be safe!
                const padding = this.chunkSize * 1000 * 2;
                const check = duration > Number(endTime) + padding;
                if (check === true) {
                    this.removeListener('update', observe);
                    resolve();
                }
            };
            this.on('update', observe);
        });
    }
    get latency() {
        return moment_1.default().diff(this.currentTime);
    }
    get realDuration() {
        return moment_1.default.duration(moment_1.default.utc().diff(this.startTime), 'ms');
    }
    get realTime() {
        return this.startTime.clone().add(this.realDuration);
    }
}
class Transcoder {
    constructor({ bufferSize = 120, chunkSize = 2, outputPath = os.tmpdir(), useManifestTimestamp = true } = {}) {
        this.bufferSize = bufferSize;
        this.chunkSize = chunkSize;
        this.outputPath = outputPath;
        this.useManifestTimestamp = useManifestTimestamp;
    }
    /**
     * Convenience method for returning URLs to Mixer's API.
     * @param uri An API resource
     * @returns Full URL to an API resource
     */
    api(uri) {
        const rexp = /^\/?(?:api\/)?(v[^\/]+)?\/?(.+)$/;
        let [, ver, resource] = uri.match(rexp) || [, , uri];
        ver = ver || 'v1';
        return `https://mixer.com/api/${ver}/${resource}`;
    }
    /**
     * Parses the contents of a playlist file and returns the collection of
     * discovered transcoder streams within it.
     * @param playlist Wall of text containing m3u8 playlist information
     */
    parsePlaylist(playlist) {
        const profiles = [];
        const streams = playlist.match(/^#EXT-X-STREAM-INF:.+$/gm) || [];
        for (const stream of streams) {
            const params = stream.replace(/^#EXT-X-STREAM-INF:/, '').split(',');
            // @todo Do something less bad here
            const profile = {
                name: 'Unknown',
                url: ''
            };
            for (const pair of params.map(param => param.split('='))) {
                const key = pair[0].toLowerCase()
                    .replace(/-([a-z])/g, m => m[1].toUpperCase());
                profile[key] = pair[1];
            }
            const descIdx = playlist.indexOf(stream) + stream.length + 1;
            profile.url = playlist.substr(descIdx).split('\n')[0];
            profiles.push(profile);
        }
        return profiles;
    }
    /**
     * Inspects a given video file, returning the resulting statistics wrapped in
     * a Promise/
     * @param file Path to the file or URL to analyze
     */
    getVideoStats(file) {
        return new Promise((res, rej) => {
            fluent_ffmpeg_1.default(file).ffprobe((err, stats) => {
                if (err) {
                    return rej(err);
                }
                res(stats);
            });
        });
    }
    /**
     * Estimates a stream's start time based on a transcode profile (extracted
     * from manifest). Assumes that the target stream contains exactly 5 "chunks"
     * in its playlist, based on personal observation.
     * @see parsePlaylist For transcode profiles
     * @param profile A transcode profile to estimate start time for
     */
    calcStartTimeFromProfile(profile) {
        return __awaiter(this, void 0, void 0, function* () {
            const { url } = profile;
            const stats = yield this.getVideoStats(url);
            const streamTime = stats.streams[0].start_time;
            const segmentDuration = yield axios_1.default.get(url)
                .then(({ data }) => (data.match(/EXT-X-TARGETDURATION:(\d+)/) || [])[1])
                .then(parseFloat);
            return moment_1.default.utc()
                .subtract(streamTime * 1000)
                .subtract(4 * segmentDuration, 's')
                .format();
        });
    }
    /**
     * Iterates over a list of transcode profiles and returns the first item in
     * the collection with a positive match or `undefined` otherwise.
     * @param name The (partial) name of the transcode profile to search for
     * @param profiles The list of transcode profiles to sift through
     */
    queryProfiles(name, profiles) {
        for (const profile of profiles) {
            if (profile.name.toLowerCase().match(name.toLowerCase())) {
                return profile;
            }
        }
    }
    /**
     * Instantiates a `ReplayBuffer` and starts recording a live stream for the
     * provided channel.
     * @todo This needs error handling: offline streams, reconnects, 404s, etc.
     * @todo Should probably reject if `quality` is provided but isn't found
     * @param token The name or numeric ID of the Mixer channel to watch
     * @param quality Desired transcode profile (e.g. "720p"), quietly ignored if
     *    it isn't found in the stream playlist
     */
    watch(token, quality = 'source') {
        return __awaiter(this, void 0, void 0, function* () {
            const channelUrl = this.api(`channels/${token}`);
            const { data: channel } = yield axios_1.default.get(channelUrl);
            const manifestUrl = this.api(`channels/${channel.id}/manifest.light2`);
            const { data: manifest } = yield axios_1.default.get(manifestUrl);
            let startTime = manifest.startedAt;
            let playlistUrl = this.api(manifest.hlsSrc);
            const profiles = yield axios_1.default.get(playlistUrl)
                .then(({ data }) => this.parsePlaylist(data));
            const profile = this.queryProfiles(quality, profiles);
            if (!profile) {
                const validQualitiesStr = profiles.map(p => `"${p.name}"`).join(', ');
                throw new Error(`Unknown quality "${quality}", valid options are: ${validQualitiesStr}`);
            }
            if (profile) {
                playlistUrl = profile.url;
                if (this.useManifestTimestamp === false) {
                    startTime = yield this.calcStartTimeFromProfile(profile);
                }
            }
            // console.log(`Selected stream: ${profiles[selectStream].name}`)
            return new Promise((res, rej) => {
                this.replayBuffer = new ReplayBuffer({
                    url: playlistUrl,
                    startTime,
                    bufferSize: this.bufferSize,
                    chunkSize: this.chunkSize,
                    outputPath: this.outputPath,
                    prefix: channel.token
                });
                this.replayBuffer.once('startWatching', () => res());
            });
        });
    }
    /**
     * Captures a segment from the replay buffer.
     * @todo Perhaps the meat of this method belongs in `ReplayBuffer`?
     * @param duration The duration to capture in seconds
     * @param predelay An additional delay to offset the capture by (in seconds),
     *    for example accounting for human response times if activated via chat
     */
    capture(duration = 30, predelay = 0) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.replayBuffer) {
                return Promise.reject(new Error('Replay buffer has not been started'));
            }
            const endTime = this.replayBuffer.realDuration.clone()
                .subtract(predelay, 's');
            const startTime = endTime.clone()
                .subtract(duration, 's');
            yield this.replayBuffer.contains(endTime);
            const offset = startTime.format('HH:mm:ss.sss', { trim: false });
            const file = `${this.replayBuffer.prefix}-capture-${shortid_1.default.generate()}.mp4`;
            const outputFile = path.join(this.outputPath, file);
            const inputFile = path.join(this.replayBuffer.outputPath, this.replayBuffer.outputFile);
            const chain = fluent_ffmpeg_1.default();
            return new Promise((resolve, reject) => {
                chain.input(inputFile)
                    .inputOptions([
                    '-f hls',
                    '-live_start_index 3'
                ])
                    .output(outputFile)
                    .outputOptions([
                    '-copyts',
                    `-ss ${offset}`,
                    `-t ${duration}`,
                    '-c copy'
                ])
                    // .on('start', cmd => console.log('Start capture', cmd))
                    // .on('progress', c => console.log('progress', c))
                    .on('end', () => resolve(outputFile))
                    .on('error', reject)
                    // .on('stderr', l => console.log(l))
                    .run();
            });
        });
    }
}
exports.default = Transcoder;
