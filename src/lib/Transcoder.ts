import EventEmitter from 'events'
import moment from 'moment'
import ffmpeg, { FfprobeData, FfmpegCommand } from 'fluent-ffmpeg'
import axios from 'axios'
import shortid from 'shortid'
import * as os from 'os'
import * as path from 'path'
import { timingSafeEqual } from 'crypto';
import { Stream } from 'stream';

require('moment-duration-format')

interface TranscoderOptions {
  ffmpegPath?: string
  bufferSize?: number
  chunkSize?: number
}

interface ReplayBufferConfig {
  url: string
  startTime: string | number | Date
  bufferSize: number
  chunkSize: number
  outputPath: string
  prefix: string
  selectStream?: number
}

interface StreamProfile {
  name: string
  url: string
  [prop: string]: any
}

class ReplayBuffer extends EventEmitter {
  url: string
  startTime: moment.Moment
  bufferSize: number
  chunkSize: number
  outputPath: string
  outputFile: string
  stream: FfmpegCommand
  prefix: string

  frames: number = 0
  duration: moment.Duration = moment.duration(0)
  currentTime: moment.Moment = moment()

  constructor ({
    url,
    startTime,
    bufferSize,
    chunkSize,
    outputPath,
    prefix,
    selectStream
  }: ReplayBufferConfig) {
    super()
    this.url = url
    this.startTime = moment.utc(startTime)
    this.bufferSize = bufferSize
    this.chunkSize = chunkSize
    this.outputPath = outputPath
    this.outputFile = `${prefix}.m3u8`
    this.prefix = prefix

    const listSize = bufferSize / chunkSize
    const fragmentFilename = `${prefix}-fragment-%d.ts`

    const stream = this.stream = ffmpeg()
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
      .run()
  }

  /**
   * Update this instance's progress with process frame count and timecodes
   * @todo Better parameter handling, this is awful
   */
  update ({ frames, timemark }: any) {
    this.frames = frames
    this.duration = moment.duration(timemark)
    this.currentTime = this.startTime.clone().add(this.duration)
    // console.log(this.duration.format('HH:mm:ss.sss'), this.latency, this.duration.asMilliseconds())
    this.emit('update', { currentTime: this.currentTime })
  }

  /**
   * Returns a promise that resolves if or when the replay buffer contains the
   * desired timecode.
   * @todo Probably needs some sort of timeout mechanism that rejects
   * @param endTime Moment-wrapped timecode to check for containment
   */
  contains (endTime: moment.Duration): Promise<void> {
    return new Promise((resolve, reject) => {
      const observe = () => {
        const duration = Number(this.duration)
        // Wait until we get two extra chunks, just to be safe!
        const padding = this.chunkSize * 1000 * 2
        const check = duration > Number(endTime) + padding
        if (check === true) {
          this.removeListener('update', observe)
          resolve()
        }
      }
      this.on('update', observe)
    })
  }

  get latency (): number {
    return moment().diff(this.currentTime)
  }

  get realDuration (): moment.Duration {
    return moment.duration(moment.utc().diff(this.startTime), 'ms')
  }

  get realTime (): moment.Moment {
    return this.startTime.clone().add(this.realDuration)
  }
}

class Transcoder implements TranscoderOptions {
  bufferSize: number
  chunkSize: number
  outputPath: string
  useManifestTimestamp: boolean

  replayBuffer?: ReplayBuffer

  constructor ({
    bufferSize = 120,
    chunkSize = 2,
    outputPath = os.tmpdir(),
    useManifestTimestamp = true
  }: any = {}) {
    this.bufferSize = bufferSize
    this.chunkSize = chunkSize
    this.outputPath = outputPath
    this.useManifestTimestamp = useManifestTimestamp
  }

  /**
   * Convenience method for returning URLs to Mixer's API.
   * @param uri An API resource
   * @returns Full URL to an API resource
   */
  api (uri: string): string {
    const rexp = /^\/?(?:api\/)?(v[^\/]+)?\/?(.+)$/
    let [, ver, resource ] = uri.match(rexp) || [,,uri]
    ver = ver || 'v1'
    return `https://mixer.com/api/${ver}/${resource}`
  }

  /**
   * Parses the contents of a playlist file and returns the collection of
   * discovered transcoder streams within it.
   * @param playlist Wall of text containing m3u8 playlist information
   */
  parsePlaylist (playlist: string): StreamProfile[] {
    const profiles = []
    const streams = playlist.match(/^#EXT-X-STREAM-INF:.+$/gm) || []
    for (const stream of streams) {
      const params = stream.replace(/^#EXT-X-STREAM-INF:/, '').split(',')
      // @todo Do something less bad here
      const profile: StreamProfile = {
        name: 'Unknown',
        url: ''
      }
      for (const pair of params.map(param => param.split('='))) {
        const key = pair[0].toLowerCase()
          .replace(/-([a-z])/g, m => m[1].toUpperCase())
        profile[key] = pair[1]
      }
      const descIdx = playlist.indexOf(stream) + stream.length + 1
      profile.url = playlist.substr(descIdx).split('\n')[0]
      profiles.push(profile)
    }
    return profiles
  }

  /**
   * Inspects a given video file, returning the resulting statistics wrapped in
   * a Promise/
   * @param file Path to the file or URL to analyze
   */
  getVideoStats (file: string): Promise<FfprobeData> {
    return new Promise((res, rej) => {
      ffmpeg(file).ffprobe((err, stats) => {
        if (err) {
          return rej(err)
        }

        res(stats)
      })
    })
  }

  /**
   * Estimates a stream's start time based on a transcode profile (extracted
   * from manifest). Assumes that the target stream contains exactly 5 "chunks"
   * in its playlist, based on personal observation.
   * @see parsePlaylist For transcode profiles
   * @param profile A transcode profile to estimate start time for
   */
  async calcStartTimeFromProfile (profile: StreamProfile): Promise<string> {
    const { url } = profile
    const stats = await this.getVideoStats(url)
    const streamTime = stats.streams[0].start_time

    const segmentDuration = await axios.get(url)
      .then(({ data }) => (data.match(/EXT-X-TARGETDURATION:(\d+)/) || [])[1])
      .then(parseFloat)

    return moment.utc()
      .subtract(streamTime * 1000)
      .subtract(4 * segmentDuration, 's')
      .format()
  }

  /**
   * Iterates over a list of transcode profiles and returns the first item in
   * the collection with a positive match or `undefined` otherwise.
   * @param name The (partial) name of the transcode profile to search for
   * @param profiles The list of transcode profiles to sift through
   */
  queryProfiles (
    name: string,
    profiles: StreamProfile[]
  ): StreamProfile | undefined {
    for (const profile of profiles) {
      if (profile.name.toLowerCase().match(name.toLowerCase())) {
        return profile
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
  async watch (token: string, quality: string = 'source'): Promise<void> {
    const channelUrl = this.api(`channels/${token}`)
    const { data: channel } = await axios.get(channelUrl)

    const manifestUrl = this.api(`channels/${channel.id}/manifest.light2`)
    const { data: manifest } = await axios.get(manifestUrl)

    let startTime = manifest.startedAt

    let playlistUrl = this.api(manifest.hlsSrc)
    const profiles = await axios.get(playlistUrl)
      .then(({ data }) => this.parsePlaylist(data))

    const profile = this.queryProfiles(quality, profiles)
    if (!profile) {
      const validQualitiesStr = profiles.map(p => `"${p.name}"`).join(', ')
      throw new Error(
        `Unknown quality "${quality}", valid options are: ${validQualitiesStr}`
      )
    }
    if (profile) {
      playlistUrl = profile.url
      if (this.useManifestTimestamp === false) {
        startTime = await this.calcStartTimeFromProfile(profile)
      }
    }

    // console.log(`Selected stream: ${profiles[selectStream].name}`)

    return new Promise<void>((res, rej) => {
      this.replayBuffer = new ReplayBuffer({
        url: playlistUrl,
        startTime,
        bufferSize: this.bufferSize,
        chunkSize: this.chunkSize,
        outputPath: this.outputPath,
        prefix: channel.token
      })

      this.replayBuffer.once('startWatching', () => res())
    })
  }

  /**
   * Captures a segment from the replay buffer.
   * @todo Perhaps the meat of this method belongs in `ReplayBuffer`?
   * @param duration The duration to capture in seconds
   * @param predelay An additional delay to offset the capture by (in seconds),
   *    for example accounting for human response times if activated via chat
   */
  async capture (duration: number = 30, predelay: number = 0): Promise<any> {
    if (!this.replayBuffer) {
      return Promise.reject(new Error('Replay buffer has not been started'))
    }

    const endTime = this.replayBuffer.realDuration.clone()
      .subtract(predelay, 's')
    const startTime = endTime.clone()
      .subtract(duration, 's')

    await this.replayBuffer.contains(endTime)

    const offset = startTime.format('HH:mm:ss.sss', { trim: false })

    const file =`${this.replayBuffer.prefix}-capture-${shortid.generate()}.mp4`
    const outputFile: string = path.join(this.outputPath, file)
    const inputFile = path.join(
      this.replayBuffer.outputPath,
      this.replayBuffer.outputFile
    )

    const chain = ffmpeg()
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
      .run()
    })
  }
}

export default Transcoder
