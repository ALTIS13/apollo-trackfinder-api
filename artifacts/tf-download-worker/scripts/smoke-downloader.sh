#!/bin/sh
set -eu

for argument in "$@"; do
  source_url=$argument
done

emit_audio() {
  duration_ms=$1
  hold_ms=${2:-0}
  exec node -e '
const durationMs = Number(process.argv[1]);
const holdMs = Number(process.argv[2]);
const sampleRate = 44_100;
const channels = 2;
const bytesPerSample = 2;
const dataBytes =
  Math.floor((sampleRate * durationMs) / 1_000) *
  channels *
  bytesPerSample;
const header = Buffer.alloc(44);
header.write("RIFF", 0, "ascii");
header.writeUInt32LE(36 + dataBytes, 4);
header.write("WAVE", 8, "ascii");
header.write("fmt ", 12, "ascii");
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(channels, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
header.writeUInt16LE(channels * bytesPerSample, 32);
header.writeUInt16LE(bytesPerSample * 8, 34);
header.write("data", 36, "ascii");
header.writeUInt32LE(dataBytes, 40);
process.stdout.write(header);
process.stdout.write(Buffer.alloc(dataBytes));
if (holdMs > 0) setTimeout(() => undefined, holdMs);
' "$duration_ms" "$hold_ms"
}

case "${source_url:-}" in
  *mode=stderr*)
    stderr_value=${source_url##*stderr=}
    stderr_value=${stderr_value%%&*}
    printf '%s\n' "$stderr_value" >&2
    exit 17
    ;;
  *mode=size*)
    emit_audio 2000
    ;;
  *mode=quota*)
    emit_audio 1500
    ;;
  *mode=hold*)
    emit_audio 1200 30000
    ;;
  *mode=deadline*)
    emit_audio 100 30000
    ;;
  *mode=active*)
    emit_audio 500 30000
    ;;
  *)
    emit_audio 100
    ;;
esac
