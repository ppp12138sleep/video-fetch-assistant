import { AppError } from '../shared/errors';
import { FfmpegRunner } from './ffmpeg-runner';
import { blobFromChunks } from './temp-store';
import type { TempChunk } from './temp-store';

export interface TrackMaterial {
  chunks: TempChunk[];
  transport: 'concat-ts' | 'file';
  extension: 'ts' | 'mp4' | 'webm' | 'aac';
}

export interface ConvertOptions {
  taskId: string;
  video: TrackMaterial;
  audio?: TrackMaterial;
  separateAudio: boolean;
  expectedAudio: boolean;
  sourceFormat: 'hls' | 'dash' | 'split' | 'webm';
  signal: AbortSignal;
  onStage: (stage: 'converting' | 'saving', message: string) => void;
}

export interface ConvertResult {
  bytes: Uint8Array;
  transcoded: boolean;
}

interface PreparedInput {
  args: string[];
  path: string;
}

function safeWorkDir(taskId: string): string {
  return `/vva-${taskId.replace(/[^a-z0-9-]/gi, '')}`;
}

async function writeTrackInput(
  runner: FfmpegRunner,
  dir: string,
  name: string,
  material: TrackMaterial,
): Promise<PreparedInput> {
  if (!material.chunks.length) {
    throw new AppError('CONVERT_FAILED', `${name} 没有临时分片`);
  }
  if (material.transport === 'concat-ts') {
    const lines: string[] = [];
    for (let index = 0; index < material.chunks.length; index += 1) {
      const chunk = material.chunks[index]!;
      const path = `${dir}/${name}-${String(index).padStart(6, '0')}.ts`;
      await runner.write(path, new Uint8Array(await chunk.data.arrayBuffer()));
      lines.push(`file '${path}'`);
    }
    const listPath = `${dir}/${name}.txt`;
    await runner.write(listPath, `${lines.join('\n')}\n`);
    return {
      path: listPath,
      args: ['-f', 'concat', '-safe', '0', '-i', listPath],
    };
  }

  const blob = blobFromChunks(material.chunks);
  const buffer = new Uint8Array(await blob.arrayBuffer());
  if (!buffer.byteLength) throw new AppError('CONVERT_FAILED', `${name} 临时文件为空`);
  const path = `${dir}/${name}.${material.extension}`;
  await runner.write(path, buffer);
  return { path, args: ['-i', path] };
}

function mapArgs(options: ConvertOptions): string[] {
  return options.separateAudio
    ? ['-map', '0:v:0', '-map', '1:a:0']
    : ['-map', '0:v:0', '-map', '0:a:0?'];
}

async function verifyMp4(runner: FfmpegRunner, path: string): Promise<Uint8Array | null> {
  try {
    const data = await runner.read(path);
    if (typeof data === 'string' || data.byteLength < 32) return null;
    const bytes = new Uint8Array(data);
    const signature = String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0);
    if (signature !== 'ftyp') return null;
    return bytes;
  } catch {
    return null;
  }
}

function codecsFromProbe(
  probe: { streams?: Array<{ codec_type?: string; codec_name?: string }> } | null,
): { video: string | null; audio: string | null } {
  let video: string | null = null;
  let audio: string | null = null;
  for (const stream of probe?.streams ?? []) {
    if (stream.codec_type === 'video' && !video) video = stream.codec_name ?? null;
    if (stream.codec_type === 'audio' && !audio) audio = stream.codec_name ?? null;
  }
  return { video, audio };
}

function transcodeArgs(
  inputs: string[],
  maps: string[],
  output: string,
  videoCodec: 'copy' | 'x264',
  audioCodec: 'copy' | 'aac',
): string[] {
  const args = [...inputs, ...maps];
  if (videoCodec === 'x264') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'copy');
  }
  if (audioCodec === 'aac') {
    args.push('-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-c:a', 'copy');
  }
  args.push('-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', output);
  return args;
}

export async function convertToMp4(options: ConvertOptions): Promise<ConvertResult> {
  if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const runner = new FfmpegRunner();
  const dir = safeWorkDir(options.taskId);
  try {
    options.onStage('converting', '正在加载本机转封装引擎…');
    await runner.load(options.signal);
    await runner.createDir(dir);
    const video = await writeTrackInput(runner, dir, 'video', options.video);
    const audio = options.audio
      ? await writeTrackInput(runner, dir, 'audio', options.audio)
      : null;
    options.onStage('converting', '正在重新封装为 MP4…');
    const inputs = [...video.args, ...(audio?.args ?? [])];
    const maps = mapArgs(options);
    const copyOutput = `${dir}/copy.mp4`;
    const copyArgs = [
      ...inputs,
      ...maps,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-avoid_negative_ts',
      'make_zero',
      copyOutput,
    ];
    const copyCode = await runner.exec(copyArgs, options.signal);
    let copied = copyCode === 0 ? await verifyMp4(runner, copyOutput) : null;
    let usedPath = copyOutput;
    let transcoded = false;

    const copyProbe =
      copied && (options.expectedAudio || options.sourceFormat === 'webm')
        ? await runner.probe(copyOutput, `${dir}/copy-probe.json`, options.signal)
        : null;
    const copyCodecs = codecsFromProbe(copyProbe);

    if (options.expectedAudio && copied && copyProbe && !copyCodecs.audio) {
      throw new AppError(
        'UNSUPPORTED_FORMAT',
        '输出 MP4 没有音频轨道',
        '合并后的文件缺少音频轨道，为避免生成无声视频已停止。',
      );
    }

    let needTargetedTranscode = false;
    if (options.sourceFormat === 'webm' && copied) {
      if (!copyProbe) {
        needTargetedTranscode = true;
      } else {
        const videoOk = ['h264', 'hevc', 'av1'].includes(copyCodecs.video ?? '');
        const audioOk =
          !copyCodecs.audio || ['aac', 'mp3'].includes(copyCodecs.audio);
        needTargetedTranscode = !videoOk || !audioOk;
      }
    }

    if (!copied || needTargetedTranscode) {
      options.onStage(
        'converting',
        options.sourceFormat === 'webm'
          ? '正在转码为兼容 Edge 的 H.264 / AAC…'
          : '直接封装失败，正在转码为兼容的 H.264 / AAC…',
      );
      const output = `${dir}/final.mp4`;
      const videoCodec =
        options.sourceFormat === 'webm' && copyProbe
          ? ['h264', 'hevc', 'av1'].includes(copyCodecs.video ?? '')
            ? 'copy'
            : 'x264'
          : 'x264';
      const audioCodec =
        options.sourceFormat === 'webm' && copyProbe && copyCodecs.audio
          ? ['aac', 'mp3'].includes(copyCodecs.audio)
            ? 'copy'
            : 'aac'
          : 'aac';
      const code = await runner.exec(
        transcodeArgs(inputs, maps, output, videoCodec, audioCodec),
        options.signal,
      );
      if (code !== 0) {
        throw new AppError(
          'ENCODE_INCOMPATIBLE',
          runner.lastLogs().slice(0, 400),
          '视频编码与 MP4 不兼容，且自动转码失败。',
        );
      }
      const data = await verifyMp4(runner, output);
      if (!data) {
        throw new AppError(
          'CONVERT_FAILED',
          '转码输出不是有效 MP4',
          '转换结果不是有效的 MP4 文件，未生成下载。',
        );
      }
      copied = data;
      usedPath = output;
      transcoded = true;
    }

    if (!copied) {
      throw new AppError('CONVERT_FAILED', '未生成有效 MP4 输出');
    }

    const finalProbe = await runner.probe(usedPath, `${dir}/final-probe.json`, options.signal);
    const finalCodecs = codecsFromProbe(finalProbe);
    if (options.expectedAudio && finalProbe && !finalCodecs.audio) {
      throw new AppError(
        'UNSUPPORTED_FORMAT',
        '最终 MP4 缺少音频轨道',
        '最终文件缺少音频轨道，未生成下载。',
      );
    }
    options.onStage('saving', 'MP4 已生成，正在创建下载…');
    return { bytes: copied, transcoded };
  } finally {
    runner.terminate();
  }
}
