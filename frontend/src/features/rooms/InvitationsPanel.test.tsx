import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from './InvitationsPanel';

const INVITE_URL = 'http://172.20.10.2:5173/invite/abc123def456';

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

afterEach(() => {
  setClipboard(undefined);
  vi.restoreAllMocks();
});

describe('copyToClipboard', () => {
  it('copies the exact invitation URL via the async clipboard API in a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    const ok = await copyToClipboard(INVITE_URL, null);

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith(INVITE_URL);
  });

  it('falls back to execCommand when the clipboard API is unavailable (LAN HTTP origin)', async () => {
    setClipboard(undefined); // navigator.clipboard is missing on non-secure origins
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    const field = document.createElement('input');
    field.value = INVITE_URL;
    document.body.appendChild(field);

    const ok = await copyToClipboard(INVITE_URL, field);

    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    field.remove();
  });

  it('reports failure gracefully when both the clipboard API and execCommand fail', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;

    const ok = await copyToClipboard(INVITE_URL, null);

    expect(ok).toBe(false);
  });
});
