import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface EncodedAsset {
  identity: Uint8Array<ArrayBuffer>;
  gzip: Uint8Array<ArrayBuffer>;
  etag: string;
}

export interface ClientAssets {
  script: EncodedAsset;
  style: EncodedAsset;
}

export async function buildClientAssets(): Promise<ClientAssets> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'client', 'main.ts'), join(ROOT, 'styles', 'index.css')],
    target: 'browser',
    format: 'esm',
    minify: true,
    naming: '[name].[ext]',
  });
  if (!result.success) {
    throw new Error(`Client build failed:\n${result.logs.map(log => String(log)).join('\n')}`);
  }

  const scriptOutput = result.outputs.find(output => output.path.endsWith('/main.js'));
  const styleOutput = result.outputs.find(output => output.path.endsWith('/index.css'));
  if (!scriptOutput || !styleOutput) throw new Error('Client build did not produce JavaScript and CSS assets');

  const [script, style] = await Promise.all([assetFromBlob(scriptOutput), assetFromBlob(styleOutput)]);
  return { script, style };
}

export function encodedAsset(bytes: Uint8Array<ArrayBuffer>): EncodedAsset {
  const hash = Bun.hash(bytes).toString(16);
  return {
    identity: bytes,
    gzip: Bun.gzipSync(bytes, { level: 6 }),
    etag: `W/"${hash}-${bytes.byteLength.toString(16)}"`,
  };
}

export function encodedResponse(
  req: Request,
  asset: EncodedAsset,
  contentType: string,
  options: { allowRange?: boolean; cacheControl?: string } = {},
): Response {
  const headers = new Headers({
    'cache-control': options.cacheControl ?? 'no-cache',
    'content-type': contentType,
    etag: asset.etag,
    vary: 'accept-encoding',
  });
  if (options.allowRange) headers.set('accept-ranges', 'bytes');
  if (req.headers.get('if-none-match') === asset.etag) return new Response(null, { status: 304, headers });

  const range = options.allowRange ? parseRange(req.headers.get('range'), asset.identity.byteLength) : null;
  if (range === 'invalid') {
    headers.set('content-range', `bytes */${asset.identity.byteLength}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set('content-range', `bytes ${range.start}-${range.end}/${asset.identity.byteLength}`);
    return new Response(asset.identity.slice(range.start, range.end + 1).buffer, { status: 206, headers });
  }

  if (acceptsGzip(req)) {
    headers.set('content-encoding', 'gzip');
    return new Response(asset.gzip.buffer, { headers });
  }
  return new Response(asset.identity.buffer, { headers });
}

function acceptsGzip(req: Request): boolean {
  return (req.headers.get('accept-encoding') ?? '').split(',').some(value => {
    const [encoding, ...parameters] = value.trim().toLowerCase().split(';');
    if (encoding !== 'gzip' && encoding !== '*') return false;
    return !parameters.some(parameter => /^q=0(?:\.0*)?$/.test(parameter.trim()));
  });
}

function parseRange(value: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return 'invalid';
  const rawStart = match[1] ? Number(match[1]) : null;
  const rawEnd = match[2] ? Number(match[2]) : null;
  const start = rawStart ?? Math.max(0, size - (rawEnd ?? 0));
  const end = rawStart === null ? size - 1 : Math.min(rawEnd ?? size - 1, size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return 'invalid';
  return { start, end };
}

async function assetFromBlob(blob: Blob): Promise<EncodedAsset> {
  return encodedAsset(new Uint8Array(await blob.arrayBuffer()));
}
