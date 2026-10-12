import { describe, expect, it } from 'vitest';
import { deviceStart, devicePoll, Credentials } from '../src/sync/providers';
import type { HttpFn } from '../src/sync/http';

type Res = { status: number; json: unknown };
const script = (answers: ((body: URLSearchParams, url: string) => Res)[]) => {
	const calls: { url: string; body: URLSearchParams }[] = [];
	const http: HttpFn = async (req) => {
		const body = new URLSearchParams(String(req.body ?? ''));
		calls.push({ url: req.url, body });
		const a = answers.shift();
		if (!a) throw new Error('unexpected request ' + req.url);
		const r = a(body, req.url);
		return { status: r.status, headers: {}, json: r.json, text: JSON.stringify(r.json), arrayBuffer: new ArrayBuffer(0) };
	};
	return { http, calls };
};
const noSleep = async () => undefined;
const google: Credentials = { provider: 'gdrive', clientId: 'id.apps.googleusercontent.com', clientSecret: 'sec' };
const ms: Credentials = { provider: 'onedrive', clientId: '1111-2222' };

describe('device sign-in (RFC 8628)', () => {
	it('Google: code, pending, slow_down, then a refresh token', async () => {
		const { http, calls } = script([
			() => ({ status: 200, json: { device_code: 'DC', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', interval: 5, expires_in: 1800 } }),
			() => ({ status: 428, json: { error: 'authorization_pending' } }),
			() => ({ status: 403, json: { error: 'slow_down' } }),
			() => ({ status: 200, json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3599 } }),
		]);
		const d = await deviceStart(http, google);
		expect(d).toMatchObject({ userCode: 'ABCD-EFGH', verifyUrl: 'https://www.google.com/device', interval: 5 });
		expect(calls[0].url).toBe('https://oauth2.googleapis.com/device/code');
		expect(calls[0].body.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
		const waits: number[] = [];
		const c = await devicePoll(http, google, d, () => false, async (ms) => void waits.push(ms));
		expect(c).toEqual({ ...google, refreshToken: 'RT' });
		expect(waits).toEqual([5000, 5000, 10000]); // slow_down adds 5 s
		const poll = calls[3].body;
		expect(poll.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
		expect(poll.get('client_secret')).toBe('sec');
		expect(poll.get('device_code')).toBe('DC');
	});

	it('Microsoft: uses the common endpoint, offline scope and no secret', async () => {
		const { http, calls } = script([
			() => ({ status: 200, json: { device_code: 'D', user_code: 'XYZ123', verification_uri: 'https://microsoft.com/devicelogin', interval: 3, expires_in: 900 } }),
			() => ({ status: 400, json: { error: 'authorization_pending' } }),
			() => ({ status: 200, json: { access_token: 'A', refresh_token: 'R' } }),
		]);
		const d = await deviceStart(http, ms);
		expect(calls[0].url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/devicecode');
		expect(calls[0].body.get('scope')).toContain('offline_access');
		const c = await devicePoll(http, ms, d, () => false, noSleep);
		expect(c?.refreshToken).toBe('R');
		expect(calls[2].body.has('client_secret')).toBe(false);
	});

	it('an app type without device sign-in is reported as unsupported (falls back to the browser)', async () => {
		const { http } = script([() => ({ status: 401, json: { error: 'invalid_client', error_description: 'Invalid client type.' } })]);
		await expect(deviceStart(http, google)).rejects.toThrow('device-unsupported');
		const { http: h2 } = script([() => ({ status: 400, json: { error: 'invalid_request', error_description: 'AADSTS7000218' } })]);
		await expect(deviceStart(h2, ms)).rejects.toThrow();
	});

	it('denied, expired, cancelled and offline moments', async () => {
		const d = { userCode: 'C', verifyUrl: 'https://x', deviceCode: 'D', interval: 1, expiresAt: Date.now() + 60_000 };
		const denied = script([() => ({ status: 403, json: { error: 'access_denied' } })]);
		await expect(devicePoll(denied.http, google, d, () => false, noSleep)).rejects.toThrow('access_denied');
		const expired = script([() => ({ status: 400, json: { error: 'expired_token' } })]);
		await expect(devicePoll(expired.http, google, d, () => false, noSleep)).rejects.toThrow('expired');
		expect(await devicePoll(script([]).http, google, d, () => true, noSleep)).toBeNull();
		let n = 0;
		const flaky: HttpFn = async () => {
			if (n++ < 2) throw new Error('offline');
			return { status: 200, headers: {}, json: { access_token: 'a', refresh_token: 'r' }, text: '', arrayBuffer: new ArrayBuffer(0) };
		};
		expect((await devicePoll(flaky, google, d, () => false, noSleep))?.refreshToken).toBe('r');
		await expect(devicePoll(script([]).http, google, { ...d, expiresAt: Date.now() - 1 }, () => false, noSleep)).rejects.toThrow('expired');
		const nosecret = script([() => ({ status: 200, json: { device_code: 'D', user_code: 'U', verification_url: 'http://evil' } })]);
		await expect(deviceStart(nosecret.http, google)).rejects.toThrow('device-unsupported'); // only https pages are opened
	});
});
