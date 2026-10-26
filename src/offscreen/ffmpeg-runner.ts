import { FFmpeg } from '@ffmpeg/ffmpeg';
import { FFMPEG_CORE_PATH, FFMPEG_WASM_PATH } from '../shared/constants';
import { AppError } from '../shared/errors';
import { sanitizeLogText } from '../shared/logger';

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
}

interface ProbeResult {
  streams?: ProbeStream[];
}

export class FfmpegRunner {
  private ffmpeg: FFmpeg | null = null;
  private loading: Promise<FFmpeg> | null = null;
  private readonly logs: string[] = [];
  private terminated = false;

  async load(signal?: AbortSignal): Promise<void> {
    if (this.ffmpeg?.loaded) return;
    if (this.loading) {
      await this.loading;
      return;
    }
    this.loading = (async () => {
      const instance = new FFmpeg();
      instance.on('log', ({ message }) => {
        if (!message) return;
        this.logs.push(sanitizeLogText(message).slice(0, 400));
        if (this.logs.length > 40) this.logs.shift();
      });
      try {
        await instance.load({
          coreURL: chrome.runtime.getURL(FFMPEG_CORE_PATH),
          wasmURL: chrome.runtime.getURL(FFMPEG_WASM_PATH),
        });
      } catch (error) {
        instance.terminate();
        throw new AppError(
          'CONVERT_FAILED',
          `ffmpeg.wasm 核心加载失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.ffmpeg = instance;
      return instance;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  private instance(): FFmpeg {
    if (!this.ffmpeg) throw new AppError('CONVERT_FAILED', 'ffmpeg 尚未初始化');
    return this.ffmpeg;
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    await this.instance().writeFile(path, data);
  }

  async read(path: string, encoding?: string): Promise<Uint8Array | string> {
    return this.instance().readFile(path, encoding);
  }

  async createDir(path: string): Promise<void> {
    try {
      await this.instance().createDir(path);
    } catch {
      // 目录已经存在时继续。
    }
  }

  async exec(args: string[], signal: AbortSignal): Promise<number> {
    const abortHandler = () => {
      this.terminate();
    };
    signal.addEventListener('abort', abortHandler, { once: true });
    try {
      return await this.instance().exec(args, -1, { signal });
    } catch (error) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new AppError(
        'CONVERT_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      signal.removeEventListener('abort', abortHandler);
    }
  }

  async probe(inputPath: string, outputPath: string, signal: AbortSignal): Promise<ProbeResult | null> {
    const abortHandler = () => this.terminate();
    signal.addEventListener('abort', abortHandler, { once: true });
    try {
      const code = await this.instance().ffprobe(
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,codec_name',
          '-of',
          'json',
          inputPath,
          '-o',
          outputPath,
        ],
        -1,
        { signal },
      );
      if (code !== 0) return null;
      const output = await this.read(outputPath, 'utf8');
      if (typeof output !== 'string') return null;
      return JSON.parse(output) as ProbeResult;
    } catch {
      return null;
    } finally {
      signal.removeEventListener('abort', abortHandler);
    }
  }

  lastLogs(): string {
    return this.logs.slice(-8).join('\n');
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    try {
      this.ffmpeg?.terminate();
    } catch {
      // 已终止。
    }
    this.ffmpeg = null;
    this.loading = null;
  }
}
