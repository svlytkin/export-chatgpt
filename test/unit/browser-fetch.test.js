'use strict';

const mockPage = {
  setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
  goto: jest.fn().mockImplementation((url) => {
    // Return a dummy successful response for the initial ChatGPT navigate
    if (url === 'https://chatgpt.com/') {
      return Promise.resolve({
        status: () => 200,
        headers: () => ({}),
        text: () => Promise.resolve(''),
      });
    }
    return Promise.resolve(null);
  }),
  evaluate: jest.fn().mockImplementation((fn) => {
    const str = fn.toString();
    if (str.includes('_cf_chl_opt')) {
      return Promise.resolve(false); // Cloudflare challenge not active
    }
    return Promise.resolve(undefined);
  }),
};

const mockContext = {
  newPage: jest.fn().mockResolvedValue(mockPage),
  addCookies: jest.fn().mockResolvedValue(undefined),
  clearCookies: jest.fn().mockResolvedValue(undefined),
  cookies: jest.fn().mockResolvedValue([]),
  addInitScript: jest.fn().mockResolvedValue(undefined),
};

const mockBrowser = {
  newContext: jest.fn().mockResolvedValue(mockContext),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn().mockResolvedValue(mockBrowser),
    executablePath: jest.fn().mockReturnValue('mock-path'),
  }
}));

const { injectSessionCookie, browserFetch, closeBrowser } = require('../../lib/browser-fetch');

const NAME = '__Secure-next-auth.session-token';

function mockCtx() {
  const added = [];
  const cleared = [];
  return {
    added,
    cleared,
    addCookies: async (cookies) => { added.push(...cookies); },
    clearCookies: async (filter) => { cleared.push(filter); },
  };
}

describe('injectSessionCookie', () => {
  test('chunks an oversized session token into .0/.1 cookies under the 4096 limit', async () => {
    const ctx = mockCtx();
    const value = 'a'.repeat(4589); // real ChatGPT JWE size — exceeds one cookie
    const headers = { Cookie: `${NAME}=${value}` };

    await injectSessionCookie(ctx, headers);

    expect(ctx.added.map(c => c.name)).toEqual([`${NAME}.0`, `${NAME}.1`]);
    expect(ctx.added.every(c => c.value.length <= 4096)).toBe(true);
    // chunks concatenate back to the original value in index order
    expect(ctx.added.map(c => c.value).join('')).toBe(value);
    // header is stripped so the oversized cookie is not also sent raw
    expect(headers.Cookie).toBeUndefined();
  });

  test('evicts a stale base-name cookie before injecting chunks', async () => {
    const ctx = mockCtx();
    const headers = { Cookie: `${NAME}=${'x'.repeat(5000)}` };

    await injectSessionCookie(ctx, headers);

    expect(ctx.cleared).toEqual([{ name: NAME }]);
  });

  test('keeps a small token as a single unsuffixed cookie without clearing', async () => {
    const ctx = mockCtx();
    const value = 'short-token';
    const headers = { Cookie: `${NAME}=${value}` };

    await injectSessionCookie(ctx, headers);

    expect(ctx.added).toHaveLength(1);
    expect(ctx.added[0].name).toBe(NAME);
    expect(ctx.added[0].value).toBe(value);
    expect(ctx.cleared).toHaveLength(0); // non-chunked needs no eviction
  });

  test('preserves other cookies in the header, stripping only the session token', async () => {
    const ctx = mockCtx();
    const headers = { Cookie: `cf_clearance=abc; ${NAME}=tok; oai-sc=def` };

    await injectSessionCookie(ctx, headers);

    expect(ctx.added.map(c => c.value).join('')).toBe('tok');
    expect(headers.Cookie).toBe('cf_clearance=abc; oai-sc=def');
  });

  test('marks chunks Secure + httpOnly with the host derived from CONFIG.baseUrl', async () => {
    const ctx = mockCtx();
    const headers = { Cookie: `${NAME}=${'x'.repeat(5000)}` };

    await injectSessionCookie(ctx, headers);

    expect(ctx.added.every(c => c.secure && c.httpOnly && c.domain === 'chatgpt.com')).toBe(true);
  });

  test('is a no-op when no Cookie header is present', async () => {
    const ctx = mockCtx();
    const headers = { Authorization: 'Bearer abc' };

    await injectSessionCookie(ctx, headers);

    expect(ctx.added).toHaveLength(0);
    expect(headers.Authorization).toBe('Bearer abc');
  });

  test('is a no-op when the Cookie header has no session token', async () => {
    const ctx = mockCtx();
    const headers = { Cookie: 'cf_clearance=xyz; other=1' };

    await injectSessionCookie(ctx, headers);

    expect(ctx.added).toHaveLength(0);
    expect(headers.Cookie).toBe('cf_clearance=xyz; other=1');
  });
});

describe('browserFetch', () => {
  afterEach(async () => {
    await closeBrowser();
    jest.clearAllMocks();
  });

  test('successfully performs fetch via page.goto and returns response', async () => {
    const mockResponse = {
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"data": "ok"}'),
    };
    mockPage.goto.mockImplementation((url) => {
      if (url === 'https://chatgpt.com/') {
        return Promise.resolve({
          status: () => 200,
          headers: () => ({}),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve(mockResponse);
    });

    const res = await browserFetch('https://chatgpt.com/backend-api/conversations');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"data": "ok"}');
    expect(await res.json()).toEqual({ data: 'ok' });
  });

  test('recovers from inspector cache eviction error by fallback to DOM innerText', async () => {
    const mockResponse = {
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      text: jest.fn().mockRejectedValue(new Error('Protocol error (Network.getResponseBody): Request content was evicted from inspector cache')),
    };
    
    mockPage.goto.mockImplementation((url) => {
      if (url === 'https://chatgpt.com/') {
        return Promise.resolve({
          status: () => 200,
          headers: () => ({}),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve(mockResponse);
    });

    mockPage.evaluate.mockImplementation((fn) => {
      const str = fn.toString();
      if (str.includes('_cf_chl_opt')) {
        return Promise.resolve(false);
      }
      if (str.includes('innerText')) {
        return Promise.resolve('{"evicted_data": "recovered_from_dom"}');
      }
      return Promise.resolve(undefined);
    });

    const res = await browserFetch('https://chatgpt.com/backend-api/conversations');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"evicted_data": "recovered_from_dom"}');
    expect(await res.json()).toEqual({ evicted_data: 'recovered_from_dom' });
  });

  test('throws original error if it is not inspector cache eviction', async () => {
    const mockResponse = {
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      text: jest.fn().mockRejectedValue(new Error('Network connection lost')),
    };
    
    mockPage.goto.mockImplementation((url) => {
      if (url === 'https://chatgpt.com/') {
        return Promise.resolve({
          status: () => 200,
          headers: () => ({}),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve(mockResponse);
    });

    await expect(browserFetch('https://chatgpt.com/backend-api/conversations'))
      .rejects.toThrow('Network connection lost');
  });

  test('correctly propagates errors without a message property without throwing TypeError', async () => {
    const mockResponse = {
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      text: jest.fn().mockRejectedValue(null), // null has no message property
    };
    
    mockPage.goto.mockImplementation((url) => {
      if (url === 'https://chatgpt.com/') {
        return Promise.resolve({
          status: () => 200,
          headers: () => ({}),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve(mockResponse);
    });

    await expect(browserFetch('https://chatgpt.com/backend-api/conversations'))
      .rejects.toBeNull();
  });
});
