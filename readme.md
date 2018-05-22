# Summary

This module "watches" a live video stream on Mixer, providing the ability to capture and save clips/highlight videos. It works by recording the stream into a short buffer (by default 2 minutes), from which clips can be extracted.

# Dependencies

* Node.JS
* A local installation of [FFMpeg](https://ffmpeg.org/)

# Example

```js
const Replay = require('mixer-replay')

// Create a replay buffer
const replay = new Replay()

// Start watching a channel on Mixer
replay.watch('ChannelName')
  .then(() => {
    // Do some stuff! Maybe listen to a "!clip" chat command or an interactive
    // button to be pressed, eventually leading to...

    // Save the last 30 seconds of video
    replay.capture(30)
      .then(fileName => {
        // `fileName` is an absolute path to the captured video. From here you
        // could upload it to a video service, move it somewhere else on disk,
        // or whatever else you'd like.
      })
  })
```
