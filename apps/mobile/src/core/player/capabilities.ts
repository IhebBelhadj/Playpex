/**
 * What this app's player decodes on the phone (libmpv: MediaCodec / VideoToolbox when the hardware can,
 * its FFmpeg in software otherwise), in ffprobe's names: every container, video and sound a release
 * carries. PUT /devices/me declares it, so the server never converts anything for this player.
 */
export const PLAYER_CAPABILITIES = {
  containers: ['mkv', 'mp4', 'm4v', 'webm', 'mov', 'avi', 'ts', 'm2ts', 'wmv', 'flv', 'mpg'],
  video: ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'msmpeg4v3', 'mpeg2video', 'mpeg1video', 'vc1', 'wmv3', 'theora'],
  audio: ['aac', 'mp3', 'mp2', 'opus', 'vorbis', 'flac', 'alac', 'ac3', 'eac3', 'dts', 'truehd', 'mlp', 'pcm_s16le', 'pcm_s24le', 'wmav2'],
}
