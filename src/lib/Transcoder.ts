import EventEmitter from 'events'
import moment from 'moment'
import ffmpeg from 'fluent-ffmpeg'
import axios from 'axios'
import * as os from 'os'
import * as path from 'path'
import { timingSafeEqual } from 'crypto';

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
}

class ReplayBuffer extends EventEmitter {
  url: string
  startTime: moment.Moment
  bufferSize: number
  chunkSize: number
  outputPath: string
  outputFile: string
  stream: ffmpeg.FfmpegCommand

  frames: number = 0
  duration: moment.Duration = moment.duration(0)
  currentTime: moment.Moment = moment()

  constructor ({
    url,
    startTime,
    bufferSize,
    chunkSize,
    outputPath,
    prefix
  }: ReplayBufferConfig) {
    super()
    this.url = url
    this.startTime = moment(startTime)
    this.bufferSize = bufferSize
    this.chunkSize = chunkSize
    this.outputPath = outputPath
    this.outputFile = `${prefix}.m3u8`

    const listSize = bufferSize / chunkSize
    const fragmentFilename = `${prefix}-fragment-%d.ts`

    const stream = this.stream = ffmpeg()
    stream
      .input(this.url)
      .inputOptions([
        '-f hls',
        '-live_start_index -3'
      ])
      .outputOptions([
        // '-map 0:p:0',
        '-copyts',
        '-vsync 2',
        `-force_key_frames expr:gte(t\,n_forced*${chunkSize})`,
        '-c:v libx264',
        '-preset ultrafast',
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

      .on('start', cmd => this.emit('startWatching', cmd))
      .on('progress', stat => this.update(stat))
      .on('end', () => this.emit('stopWatching'))
      .on('error', (err, stdout, stderr) => this.emit('error', {
        err,
        stdout,
        stderr
      }))
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
    this.emit('update', { currentTime: this.currentTime })
  }

  get latency (): number {
    return moment().diff(this.currentTime)
  }

  get realDuration (): moment.Duration {
    return moment.duration(moment.utc().diff(this.startTime))
  }

  get realTime (): moment.Moment {
    return this.startTime.clone().add(this.realDuration)
  }
}

class Transcoder implements TranscoderOptions {
  bufferSize: number
  chunkSize: number
  outputPath: string

  replayBuffer?: ReplayBuffer

  constructor ({
    bufferSize = 120,
    chunkSize = 2,
    outputPath = os.tmpdir()
  }: any = {}) {
    this.bufferSize = bufferSize
    this.chunkSize = chunkSize
    this.outputPath = outputPath
  }

  /**
   * Convenience method for returning URLs to Mixer's API.
   * @param resource An API resource
   * @returns Full URL to an API resource
   */
  api (resource: string): string {
    return `https://mixer.com/api/v1/${resource}`
  }

  // @todo catch/throw errs, .then chain on axios?
  /**
   * Instantiates a `ReplayBuffer` and starts recording a live stream for the
   * provided channel.
   * @todo This needs error handling: offline streams, reconnects, 404s, etc.
   * @todo Resolve once the transcoder process has actually started
   * @param token The name or numeric ID of the Mixer channel to watch
   */
  async watch (token: string): Promise<void> {
    const channelUrl = this.api(`channels/${token}`)
    const { data: channel } = await axios.get(channelUrl)

    const manifestUrl = this.api(`channels/${channel.id}/manifest.light2`)
    const { data: manifest } = await axios.get(manifestUrl)

    this.replayBuffer = new ReplayBuffer({
      url: `https://mixer.com${manifest.hlsSrc}`,
      startTime: manifest.startedAt,
      bufferSize: this.bufferSize,
      chunkSize: this.chunkSize,
      outputPath: this.outputPath,
      prefix: channel.token
    })

    this.replayBuffer.on('startWatching', cmd => {
      console.log('start watching', cmd)
    })
    this.replayBuffer.on('stopWatching', cmd => {
      console.log('stop watching', cmd)
    })
    this.replayBuffer.on('error', out => {
      console.log('err', out)
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
      return Promise.reject()
    }

    // @todo Account for latency/"realDuration": the comparison between a
    // stream's timecode and the duration resolved from the dates reported in
    // the manifest can't be reliable. Also, FTL vs. "traditional" lag.
    const offset = this.replayBuffer.duration.clone()
      .subtract(predelay + duration, 's')
      .format('HH:mm:ss.sss', { trim: false })
    const file =`output-${this.replayBuffer.frames}.mp4`
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
      .run()
    })
  }
}

export default Transcoder
