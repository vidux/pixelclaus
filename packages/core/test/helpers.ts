import {
  createDocument,
  type CreateDocumentOptions,
  type SpriteDocument,
  compositeFrame,
  readPixels,
} from '../src/index.js';

export function makeDoc(opts: Partial<CreateDocumentOptions> = {}): SpriteDocument {
  return createDocument({ name: 'test', width: 8, height: 8, palette: 'pico-8', ...opts });
}

/** ASCII rows of a layer (no header/row numbers). */
export function rows(doc: SpriteDocument, layer?: string, frame = 0): string[] {
  return readPixels(doc, { layer, frame, rowNumbers: false, header: false }).text.split('\n');
}

export function opaqueCount(doc: SpriteDocument, frame = 0): number {
  const r = compositeFrame(doc, { frame });
  let n = 0;
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i]! > 0) n++;
  return n;
}
