// Why: iOS streams MJPEG and Android will stream H.264, but the IPC session
// owns a stream object with the same start/stop lifecycle. One interface lets
// the session field be typed against both without a structural { start; stop }.
export type FrameStream = {
  start(): void
  stop(): void
}
