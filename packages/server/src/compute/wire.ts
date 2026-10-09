/**
 * Errors cross the worker boundary as plain objects; PixelClausErrors keep their code and hint so tools
 * and REST map them exactly as if they had been thrown on the main thread.
 */
import { PixelClausError, type ErrorCode } from '@pixelclaus/core';

export interface WireError {
  name: string;
  message: string;
  code?: string;
  hint?: string;
}

export function toWireError(e: unknown): WireError {
  if (e instanceof PixelClausError) return { name: e.name, message: e.message, code: e.code, hint: e.hint };
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { name: 'Error', message: String(e) };
}

export function fromWireError(w: WireError): Error {
  if (w.code) return new PixelClausError(w.code as ErrorCode, w.message, w.hint);
  const e = new Error(w.message);
  e.name = w.name;
  return e;
}
