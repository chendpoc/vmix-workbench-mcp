import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Config } from './config.js';

export class Fault extends Error {
  constructor(
    public code: string,
    message: string,
    public uncertain = false,
  ) {
    super(message);
  }
}
export interface Input {
  key: string;
  number: number;
  title: string;
  type: string;
  state: string;
  position: number;
  duration: number;
  loop: boolean;
  texts: { name: string; value: string }[];
  images: { name: string; value: string }[];
  layers: { index: number; key: string }[];
}
export interface State {
  version: string;
  edition: string;
  observedAt: string;
  active: string | null;
  preview: string | null;
  inputs: Input[];
  overlays: { number: number; key: string | null }[];
  recording: boolean;
  streaming: boolean;
}
const list = (x: any): any[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const bool = (x: any) => String(x).toLowerCase() === 'true';
const str = (x: any): string =>
  x == null ? '' : typeof x === 'object' ? String(x['#text'] ?? '') : String(x);
export function parseState(xml: string): State {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Fault('INVALID_STATE', 'vMix returned invalid/unsafe XML');
  const root = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
  }).parse(xml);
  const v = root.vmix;
  if (!v || typeof v !== 'object' || !/^\d+\.\d+/.test(str(v.version)) || !('inputs' in v))
    throw new Fault('INVALID_STATE', 'Response is not a supported vMix state document');
  const inputs = list(v.inputs?.input).map((i: any): Input => ({
    key: str(i.key),
    number: Number(i.number),
    title: str(i.title),
    type: str(i.type),
    state: str(i.state),
    position: Number(i.position ?? 0),
    duration: Number(i.duration ?? 0),
    loop: bool(i.loop),
    texts: list(i.text).map((t) => ({ name: str(t.name), value: str(t) })),
    images: list(i.image).map((t) => ({ name: str(t.name), value: str(t) })),
    layers: list(i.overlay).map((l) => ({ index: Number(l.index) + 1, key: str(l.key) })),
  }));
  if (
    inputs.some((i) => !i.key || !Number.isInteger(i.number) || i.number < 1) ||
    new Set(inputs.map((i) => i.key)).size !== inputs.length ||
    new Set(inputs.map((i) => i.number)).size !== inputs.length
  )
    throw new Fault('INVALID_STATE', 'Missing or duplicate input identities');
  const key = (n: any) => inputs.find((i) => i.number === Number(str(n)))?.key ?? null;
  return {
    version: str(v.version),
    edition: str(v.edition),
    observedAt: new Date().toISOString(),
    inputs,
    active: key(v.active),
    preview: key(v.preview),
    overlays: list(v.overlays?.overlay).map((o) => ({ number: Number(o.number), key: key(o) })),
    recording: bool(v.recording),
    streaming: bool(v.streaming),
  };
}
export function resolveInput(state: State, ref: string): Input {
  const byKey = state.inputs.find((i) => i.key === ref);
  if (byKey) return byKey;
  const matches = state.inputs.filter((i) => i.title === ref);
  if (matches.length !== 1)
    throw new Fault(
      'INPUT_REFERENCE',
      `Input must be an existing GUID or unique exact name: ${ref}`,
    );
  return matches[0]!;
}

export class VmixClient {
  constructor(private config: Config) {}
  async request(params?: Record<string, string>): Promise<string> {
    const url = new URL(this.config.apiUrl);
    if (params) url.search = new URLSearchParams(params).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: this.config.authorization ? { Authorization: this.config.authorization } : {},
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Fault('API_REJECTED', `vMix HTTP ${response.status}`, Boolean(params));
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new Fault('RESPONSE_LIMIT', 'vMix response exceeds 8 MiB', Boolean(params));
          }
          chunks.push(value);
        }
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault(
        controller.signal.aborted ? 'TIMEOUT' : 'CONNECTION',
        controller.signal.aborted
          ? 'vMix request deadline exceeded (including body)'
          : 'Cannot complete request to configured vMix endpoint',
        Boolean(params),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async state(): Promise<State> {
    return parseState(await this.request());
  }
  async command(func: string, params: Record<string, string> = {}): Promise<void> {
    await this.request({ Function: func, ...params });
  }
}
