/**
 * AI settings: bring-your-own-key + custom instructions.
 *
 * The API key is stored only on this device, encrypted (see secure-store.ts),
 * and is decrypted just-in-time for the single AI request that uses it. It is
 * never placed in localStorage, the request body, a URL, the DOM, or logs.
 * Provider, model and custom instructions are not secret and live in
 * localStorage so they survive reloads.
 */
import {
  deleteSecret, hasSecret, isSecureStoreAvailable, loadSecret, saveSecret, SecureStoreUnavailableError,
} from './secure-store.js';

export interface AiProviderOption { id: string; label: string; defaultModel: string }

export const FALLBACK_PROVIDERS: readonly AiProviderOption[] = [
  { id: 'hackclub', label: 'Hack Club AI', defaultModel: 'z-ai/glm-5.3-flash' },
];

export const INSTRUCTIONS_KEY = 'indeev.ai.instructions';
export const PROVIDER_KEY = 'indeev.ai.provider';
export const MODEL_KEY = 'indeev.ai.model';
const SECRET_NAME = 'ai-api-key';
export const MAX_INSTRUCTIONS = 2000;

const MODEL_PATTERN = /^[A-Za-z0-9._:/@+-]{1,128}$/;
const KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;

/** Headers the server reads for a device key (never put in a body or URL). */
export interface AiAuth { key: string; provider: string; model?: string }

export function aiAuthHeaders(auth: AiAuth | undefined): Record<string, string> {
  if (!auth) return {};
  return {
    'x-indeev-ai-key': auth.key,
    'x-indeev-ai-provider': auth.provider,
    ...(auth.model ? { 'x-indeev-ai-model': auth.model } : {}),
  };
}

export function validModel(value: string): boolean {
  return value === '' || MODEL_PATTERN.test(value);
}

export function validKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

export function clampInstructions(value: string): string {
  return value.slice(0, MAX_INSTRUCTIONS);
}

/** Server list when it is well-formed, otherwise the built-in fallback. */
export function providerOptions(raw: unknown): AiProviderOption[] {
  if (!Array.isArray(raw)) return [...FALLBACK_PROVIDERS];
  const list = raw.filter((p): p is AiProviderOption =>
    p != null && typeof p === 'object' &&
    typeof (p as AiProviderOption).id === 'string' && /^[a-z0-9-]{1,32}$/.test((p as AiProviderOption).id) &&
    typeof (p as AiProviderOption).label === 'string' && (p as AiProviderOption).label.length <= 64 &&
    typeof (p as AiProviderOption).defaultModel === 'string' && MODEL_PATTERN.test((p as AiProviderOption).defaultModel));
  return list.length > 0 ? list : [...FALLBACK_PROVIDERS];
}

function readLocal(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}
function writeLocal(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* storage blocked: settings just do not persist */ }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function aiSettingsMarkup(): string {
  return `
    <details class="ai-settings" data-ai-settings>
      <summary class="ai-settings-summary">
        <span class="ai-settings-glyph" aria-hidden="true"></span>
        <span class="ai-settings-title">AI settings</span>
        <span class="ai-key-pill" data-ai-key-pill>No key</span>
      </summary>
      <div class="ai-settings-body">
        <div class="ai-settings-row">
          <div class="ai-field">
            <label for="ai-provider" class="search-label">Provider</label>
            <select class="select" id="ai-provider" data-ai-provider></select>
          </div>
          <div class="ai-field">
            <label for="ai-model" class="search-label">Model (optional)</label>
            <input class="input" id="ai-model" data-ai-model type="text" autocomplete="off" spellcheck="false" maxlength="128" />
          </div>
        </div>
        <label for="ai-key" class="search-label">API key</label>
        <div class="ai-key-row">
          <input class="input" id="ai-key" data-ai-key type="password" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="512" placeholder="Paste your key" aria-describedby="ai-key-status ai-privacy" />
          <button type="button" class="btn btn-compact" data-variant="secondary" data-size="sm" data-ai-key-save>Save key on this device</button>
        </div>
        <div class="ai-key-status" id="ai-key-status" data-ai-key-status role="status" aria-live="polite">No AI key saved on this device.</div>
        <button type="button" class="btn btn-compact btn-ghost ai-key-remove hidden" data-variant="outline" data-size="sm" data-ai-key-remove>Remove key</button>
        <p class="hint ai-privacy" id="ai-privacy">
          Your key is encrypted and stored only in this browser. It is sent only with AI planning requests,
          through this app's server to the provider you chose, and is never saved on the server.
        </p>
      </div>
    </details>`;
}

export interface AiSettingsController {
  /** Show provider list / server-key note once /api/health answers. */
  applyHealth(health: { ai?: boolean; aiProviders?: unknown }): void;
  /** Decrypt the device key just-in-time. undefined = no device key. */
  readAuth(): Promise<AiAuth | undefined>;
  hasDeviceKey(): Promise<boolean>;
  /** Open the settings and focus the key field (used when a key is missing). */
  revealKeyField(): void;
}

export function wireAiSettings(box: HTMLElement): AiSettingsController {
  const details = box.querySelector<HTMLDetailsElement>('[data-ai-settings]')!;
  const provider = box.querySelector<HTMLSelectElement>('[data-ai-provider]')!;
  const model = box.querySelector<HTMLInputElement>('[data-ai-model]')!;
  const keyInput = box.querySelector<HTMLInputElement>('[data-ai-key]')!;
  const saveButton = box.querySelector<HTMLButtonElement>('[data-ai-key-save]')!;
  const removeButton = box.querySelector<HTMLButtonElement>('[data-ai-key-remove]')!;
  const status = box.querySelector<HTMLElement>('[data-ai-key-status]')!;
  const pill = box.querySelector<HTMLElement>('[data-ai-key-pill]')!;
  const instructions = box.querySelector<HTMLTextAreaElement>('#ai-request');
  const instructionsHint = box.querySelector<HTMLElement>('[data-ai-instructions-saved]');

  let providers: AiProviderOption[] = [...FALLBACK_PROVIDERS];
  let serverKey = false;

  const renderProviders = (): void => {
    const stored = readLocal(PROVIDER_KEY);
    provider.innerHTML = providers.map((p) =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('');
    provider.value = providers.some((p) => p.id === stored) ? stored : (providers[0]?.id ?? '');
    syncModelPlaceholder();
  };
  const syncModelPlaceholder = (): void => {
    const current = providers.find((p) => p.id === provider.value);
    model.placeholder = current ? `Default: ${current.defaultModel}` : 'Provider default';
  };

  const setKeyState = (saved: boolean, flash = false): void => {
    box.classList.toggle('has-ai-key', saved);
    pill.textContent = saved ? 'Key saved' : serverKey ? 'Server key' : 'No key';
    pill.classList.toggle('is-on', saved || serverKey);
    removeButton.classList.toggle('hidden', !saved);
    status.textContent = saved
      ? 'Key saved on this device (encrypted). It is sent only with AI planning requests.'
      : serverKey
        ? 'No device key saved. The server has its own AI key; your own key would override it.'
        : 'No AI key saved on this device.';
    status.classList.toggle('is-saved', saved);
    if (flash) {
      status.classList.remove('just-saved');
      void status.offsetWidth; // restart the confirmation animation
      status.classList.add('just-saved');
    }
  };

  model.value = readLocal(MODEL_KEY);
  renderProviders();
  void hasSecret(SECRET_NAME).then((saved) => setKeyState(saved));

  provider.addEventListener('change', () => { writeLocal(PROVIDER_KEY, provider.value); syncModelPlaceholder(); });
  model.addEventListener('change', () => {
    const value = model.value.trim();
    model.setCustomValidity(validModel(value) ? '' : 'Letters, digits and . _ : / @ + - only.');
    if (validModel(value)) writeLocal(MODEL_KEY, value);
    else model.reportValidity();
  });

  if (instructions) {
    instructions.maxLength = MAX_INSTRUCTIONS;
    instructions.value = clampInstructions(readLocal(INSTRUCTIONS_KEY));
    let timer: number | undefined;
    instructions.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        writeLocal(INSTRUCTIONS_KEY, clampInstructions(instructions.value.trim() ? instructions.value : ''));
        instructionsHint?.classList.remove('pulse');
        void instructionsHint?.offsetWidth;
        instructionsHint?.classList.add('pulse');
      }, 350);
    });
  }

  const save = async (): Promise<void> => {
    const value = keyInput.value.trim();
    if (!validKey(value)) {
      status.textContent = 'That does not look like an API key (8–512 characters, no spaces). Nothing was saved.';
      status.classList.remove('is-saved');
      keyInput.focus();
      return;
    }
    saveButton.disabled = true;
    try {
      await saveSecret(SECRET_NAME, value);
      keyInput.value = '';
      setKeyState(true, true);
    } catch (err) {
      status.textContent = err instanceof SecureStoreUnavailableError
        ? err.message
        : 'The key could not be saved on this device. Nothing was stored.';
      status.classList.remove('is-saved');
    } finally {
      saveButton.disabled = false;
    }
  };
  saveButton.addEventListener('click', () => void save());
  keyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void save(); }
  });
  removeButton.addEventListener('click', () => {
    void deleteSecret(SECRET_NAME).catch(() => undefined).then(() => {
      setKeyState(false);
      status.textContent = 'Key removed from this device.';
    });
  });

  if (!isSecureStoreAvailable()) {
    saveButton.disabled = true;
    keyInput.disabled = true;
    status.textContent = new SecureStoreUnavailableError().message;
  }

  return {
    applyHealth(health) {
      serverKey = health.ai === true;
      providers = providerOptions(health.aiProviders);
      renderProviders();
      void hasSecret(SECRET_NAME).then((saved) => setKeyState(saved));
    },
    async readAuth() {
      if (!isSecureStoreAvailable()) return undefined;
      const key = await loadSecret(SECRET_NAME).catch(() => null);
      if (!key) { setKeyState(false); return undefined; }
      const chosenModel = model.value.trim();
      return {
        key,
        provider: provider.value || FALLBACK_PROVIDERS[0]!.id,
        ...(chosenModel && validModel(chosenModel) ? { model: chosenModel } : {}),
      };
    },
    hasDeviceKey: () => hasSecret(SECRET_NAME),
    revealKeyField() {
      details.open = true;
      keyInput.focus({ preventScroll: false });
      details.classList.remove('nudge');
      void details.offsetWidth;
      details.classList.add('nudge');
    },
  };
}
