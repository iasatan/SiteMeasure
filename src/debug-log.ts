export interface DebugEntry {
  time: string;
  type: string;
  detail: string;
}

export interface DebugSession {
  enabled: boolean;
  startedAt: string;
  stoppedAt: string | null;
  entries: DebugEntry[];
  dropped: number;
}

const STORAGE_KEY = 'sitemeasure:debug-session';
const MAX_ENTRIES = 1000;
const EVENT_TYPES = [
  'click', 'dblclick', 'contextmenu', 'input', 'change', 'submit', 'reset',
  'focus', 'blur', 'keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
  'mousedown', 'mousemove', 'mouseup', 'wheel', 'touchstart', 'touchmove', 'touchend', 'touchcancel',
  'dragstart', 'drag', 'dragend', 'dragover', 'drop',
  'load', 'error', 'abort', 'scroll', 'resize', 'visibilitychange', 'online', 'offline',
  'pageshow', 'pagehide', 'beforeunload', 'hashchange', 'popstate',
];

export class DebugLog {
  private session: DebugSession | null = null;
  private storageFailed = false;
  private saveTimer: number | undefined;

  constructor(private readonly storage: Storage, private readonly target: Window & typeof globalThis) {
    try {
      const saved = storage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (isSession(parsed)) this.session = parsed;
      }
    } catch {
      this.storageFailed = true;
    }

    for (const type of EVENT_TYPES) {
      target.addEventListener(type, (event) => this.recordEvent(event), true);
    }
    target.addEventListener('error', (event) => {
      if (event instanceof ErrorEvent) {
        this.record('error', `${event.message} ${event.filename}:${event.lineno}:${event.colno}\n${describe(event.error)}`);
      }
    });
    target.addEventListener('unhandledrejection', (event) => this.record('unhandledrejection', describe(event.reason)));
    target.addEventListener('pagehide', () => this.persist());
    for (const level of ['debug', 'log', 'info', 'warn', 'error'] as const) {
      const original = target.console[level];
      target.console[level] = (...args: unknown[]) => {
        this.record(`console.${level}`, args.map(describe).join(' '));
        original.apply(target.console, args);
      };
    }
    if (this.session?.enabled) this.record('session', 'Recording resumed after page load');
  }

  get current(): DebugSession | null { return this.session; }
  get hasStorageError(): boolean { return this.storageFailed; }

  start(): void {
    this.storageFailed = false;
    this.session = { enabled: true, startedAt: new Date().toISOString(), stoppedAt: null, entries: [], dropped: 0 };
    this.record('session', `Recording started; ${this.target.navigator.userAgent}`);
    this.persist();
  }

  stop(): void {
    if (!this.session?.enabled) return;
    this.record('session', 'Recording stopped');
    this.session.enabled = false;
    this.session.stoppedAt = new Date().toISOString();
    this.persist();
  }

  log(type: string, detail: unknown): void {
    this.record(type, describe(detail));
  }

  private recordEvent(event: Event): void {
    const target = event.target;
    let detail = target instanceof Element
      ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}${target.getAttribute('aria-label') ? ` [${target.getAttribute('aria-label')}]` : ''}`
      : target === this.target ? 'window' : target === this.target.document ? 'document' : 'other';
    if (target instanceof Element) {
      const button = target.closest('button');
      if (button?.textContent?.trim()) detail += ` button=${button.textContent.trim().slice(0, 100)}`;
    }
    if (event instanceof KeyboardEvent) detail += ` key=${event.key.length === 1 ? '[character]' : event.key}`;
    if (event instanceof MouseEvent) detail += ` x=${event.clientX} y=${event.clientY}`;
    this.record(`event.${event.type}`, detail);
  }

  private record(type: string, detail: string): void {
    if (!this.session?.enabled) return;
    this.session.entries.push({ time: new Date().toISOString(), type, detail: detail.slice(0, 1000) });
    if (this.session.entries.length > MAX_ENTRIES) {
      this.session.entries.shift();
      this.session.dropped += 1;
    }
    if (this.saveTimer === undefined) this.saveTimer = this.target.setTimeout(() => this.persist(), 250);
  }

  private persist(): void {
    this.target.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.session) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.session));
    } catch {
      this.storageFailed = true;
    }
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function isSession(value: unknown): value is DebugSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<DebugSession>;
  return typeof session.enabled === 'boolean' && typeof session.startedAt === 'string'
    && (session.stoppedAt === null || typeof session.stoppedAt === 'string')
    && Array.isArray(session.entries) && typeof session.dropped === 'number';
}