import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OcrService } from '../OcrService';

// Fake Tika server mimicking the Tika 4 REST API (PUT /tika/text, GET /version)
let server: http.Server;
let baseUrl: string;
let putRequests: { url: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
let responder: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void;

const defaultResponder: typeof responder = (req, res, body) => {
	if (req.method === 'GET' && req.url === '/version') {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('Apache Tika 4.0.0');
		return;
	}
	if (req.method === 'PUT' && req.url === '/tika/text') {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end(`  extracted:${body.toString()}\n`);
		return;
	}
	res.writeHead(404).end();
};

describe('OcrService (Tika REST API)', () => {
	const originalUrl = process.env.TIKA_URL;
	let service: OcrService;

	before(async () => {
		server = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				const body = Buffer.concat(chunks);
				if (req.method === 'PUT') {
					putRequests.push({ url: req.url ?? '', headers: req.headers, body });
				}
				responder(req, res, body);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(async () => {
		await new Promise((resolve) => server.close(resolve));
		if (originalUrl === undefined) delete process.env.TIKA_URL;
		else process.env.TIKA_URL = originalUrl;
	});

	beforeEach(() => {
		putRequests = [];
		responder = defaultResponder;
		process.env.TIKA_URL = baseUrl;
		service = new OcrService();
	});

	afterEach(() => service.clearTikaCache());

	it('throws when TIKA_URL is not set', async () => {
		delete process.env.TIKA_URL;
		await assert.rejects(() => service.extractTextWithTika(Buffer.from('a'), 'text/plain'), /TIKA_URL/);
	});

	it('sends PUT /tika/text with Content-Type and Accept: text/plain and trims the result', async () => {
		const result = await service.extractTextWithTika(Buffer.from('hello'), 'application/pdf');
		assert.equal(result, 'extracted:hello');
		assert.equal(putRequests.length, 1);
		assert.equal(putRequests[0].url, '/tika/text');
		assert.equal(putRequests[0].headers['content-type'], 'application/pdf');
		assert.equal(putRequests[0].headers['accept'], 'text/plain');
	});

	it('forwards MIME types of all supported formats unchanged', async () => {
		const mimeTypes = [
			'application/pdf',
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/vnd.openxmlformats-officedocument.presentationml.presentation',
			'image/png',
			'image/jpeg',
			'image/tiff',
			'message/rfc822',
			'application/vnd.ms-outlook',
			'application/zip',
			'application/x-tar',
			'application/gzip',
		];
		for (const [i, mime] of mimeTypes.entries()) {
			await service.extractTextWithTika(Buffer.from(`doc-${i}`), mime);
		}
		assert.deepEqual(
			putRequests.map((r) => r.headers['content-type']),
			mimeTypes
		);
	});

	it('falls back to application/octet-stream for an empty MIME type', async () => {
		await service.extractTextWithTika(Buffer.from('x'), '');
		assert.equal(putRequests[0].headers['content-type'], 'application/octet-stream');
	});

	it('caches results by buffer content', async () => {
		const buf = Buffer.from('cache me');
		await service.extractTextWithTika(buf, 'text/plain');
		await service.extractTextWithTika(Buffer.from('cache me'), 'text/plain');
		assert.equal(putRequests.length, 1);
		const stats = service.getTikaCacheStats();
		assert.equal(stats.hits, 1);
		assert.equal(stats.size, 1);
	});

	it('deduplicates parallel requests for the same content via the semaphore', async () => {
		responder = (req, res, body) => {
			setTimeout(() => defaultResponder(req, res, body), 50);
		};
		const buf = Buffer.from('parallel');
		const results = await Promise.all([
			service.extractTextWithTika(buf, 'text/plain'),
			service.extractTextWithTika(buf, 'text/plain'),
			service.extractTextWithTika(buf, 'text/plain'),
		]);
		assert.deepEqual(results, ['extracted:parallel', 'extracted:parallel', 'extracted:parallel']);
		assert.equal(putRequests.length, 1);
		assert.deepEqual(service.getTikaSemaphoreStats(), { inProgress: 0, waitCount: 0 });
	});

	it('returns an empty string (and caches it) when Tika responds with an error', async () => {
		responder = (_req, res) => {
			res.writeHead(500).end();
		};
		const buf = Buffer.from('boom');
		assert.equal(await service.extractTextWithTika(buf, 'text/plain'), '');
		assert.equal(await service.extractTextWithTika(buf, 'text/plain'), '');
		assert.equal(putRequests.length, 1);
	});

	it('returns an empty string when Tika is unreachable so callers can use legacy extraction', async () => {
		process.env.TIKA_URL = 'http://127.0.0.1:1';
		assert.equal(await service.extractTextWithTika(Buffer.from('x'), 'text/plain'), '');
	});

	it('clearTikaCache resets statistics', async () => {
		await service.extractTextWithTika(Buffer.from('a'), 'text/plain');
		service.clearTikaCache();
		assert.deepEqual(service.getTikaCacheStats(), {
			size: 0,
			maxSize: 50,
			hits: 0,
			misses: 0,
			hitRate: 0,
		});
	});

	describe('health check', () => {
		it('is available when /version responds OK', async () => {
			assert.equal(await service.checkTikaAvailability(), true);
		});

		it('is unavailable when /version fails', async () => {
			responder = (_req, res) => {
				res.writeHead(503).end();
			};
			assert.equal(await service.checkTikaAvailability(), false);
		});

		it('is unavailable when TIKA_URL is not set', async () => {
			delete process.env.TIKA_URL;
			assert.equal(await service.checkTikaAvailability(), false);
		});

		it('is unavailable when the server is unreachable', async () => {
			process.env.TIKA_URL = 'http://127.0.0.1:1';
			assert.equal(await service.checkTikaAvailability(), false);
		});
	});
});
