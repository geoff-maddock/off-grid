/**
 * Minimal AWS Signature V4 implementation for R2 presigned URLs.
 * Based on the approach used by Cloudflare's own examples.
 */

export class AwsClient {
  constructor({ accessKeyId, secretAccessKey, service, region }) {
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.service = service || 's3';
    this.region = region || 'auto';
  }

  async sign(url, options = {}) {
    const method = options.method || 'GET';
    const parsedUrl = new URL(url);
    const headers = new Headers(options.headers || {});
    const signQuery = options.aws?.signQuery || false;
    const expiresIn = options.aws?.expiresIn || 86400;

    const now = new Date();
    const datestamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const dateOnly = datestamp.substring(0, 8);

    const credential = `${this.accessKeyId}/${dateOnly}/${this.region}/${this.service}/aws4_request`;

    if (signQuery) {
      parsedUrl.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
      parsedUrl.searchParams.set('X-Amz-Credential', credential);
      parsedUrl.searchParams.set('X-Amz-Date', datestamp);
      parsedUrl.searchParams.set('X-Amz-Expires', String(expiresIn));
      parsedUrl.searchParams.set('X-Amz-SignedHeaders', 'host');
    } else {
      headers.set('x-amz-date', datestamp);
    }

    // Canonical request
    const signedHeaders = signQuery ? 'host' : this._getSignedHeaders(headers);
    const canonicalHeaders = signQuery
      ? `host:${parsedUrl.host}\n`
      : this._getCanonicalHeaders(headers, parsedUrl.host);
    const payloadHash = signQuery ? 'UNSIGNED-PAYLOAD' : await this._hash('');

    // Sort query parameters
    const sortedParams = [...parsedUrl.searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const canonicalRequest = [
      method,
      parsedUrl.pathname,
      sortedParams,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    // String to sign
    const scope = `${dateOnly}/${this.region}/${this.service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      datestamp,
      scope,
      await this._hash(canonicalRequest),
    ].join('\n');

    // Signing key
    const signingKey = await this._getSignatureKey(dateOnly);
    const signature = await this._hmacHex(signingKey, stringToSign);

    if (signQuery) {
      parsedUrl.searchParams.set('X-Amz-Signature', signature);
      return { url: parsedUrl.toString() };
    }

    headers.set(
      'Authorization',
      `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    );

    return { url: parsedUrl.toString(), headers };
  }

  _getSignedHeaders(headers) {
    const keys = ['host'];
    for (const [key] of headers.entries()) {
      keys.push(key.toLowerCase());
    }
    return [...new Set(keys)].sort().join(';');
  }

  _getCanonicalHeaders(headers, host) {
    const map = new Map();
    map.set('host', host);
    for (const [key, value] of headers.entries()) {
      map.set(key.toLowerCase(), value.trim());
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}\n`)
      .join('');
  }

  async _hash(data) {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    return this._bufToHex(hashBuffer);
  }

  async _hmac(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      typeof key === 'string' ? new TextEncoder().encode(key) : key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  }

  async _hmacHex(key, data) {
    const sig = await this._hmac(key, data);
    return this._bufToHex(sig);
  }

  async _getSignatureKey(dateOnly) {
    let key = await this._hmac(`AWS4${this.secretAccessKey}`, dateOnly);
    key = await this._hmac(key, this.region);
    key = await this._hmac(key, this.service);
    key = await this._hmac(key, 'aws4_request');
    return key;
  }

  _bufToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
