/** 复制为独立的 ArrayBuffer，兼容 WebCrypto 与 Blob 的类型要求。 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function asBlobPart(bytes: Uint8Array): BlobPart {
  return toArrayBuffer(bytes);
}
