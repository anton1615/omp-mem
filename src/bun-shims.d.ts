declare module "bun:sqlite" {
  export interface StatementRunResult {
    lastInsertRowid: number | bigint;
  }

  export interface Statement {
    run(...params: unknown[]): StatementRunResult;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  }

  export class Database {
    constructor(filename: string);
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
}

declare module "@oh-my-pi/pi-ai" {
  export function complete(
    model: unknown,
    context: { messages: Array<{ role: "user" | "assistant" | "system"; content: Array<{ type: "text"; text: string }>; timestamp?: number }> },
    options: { apiKey?: string; maxTokens?: number; signal?: AbortSignal },
  ): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

declare module "bun:test" {
  export function test(name: string, fn: () => unknown | Promise<unknown>): void;
  export function beforeEach(fn: () => unknown | Promise<unknown>): void;
  export function afterEach(fn: () => unknown | Promise<unknown>): void;
  export function expect(value: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toBeDefined(): void;
    not: {
      toContain(expected: unknown): void;
    };
  };
}

declare module "node:fs/promises" {
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(filePath: string, options?: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number }): Promise<void>;
  export function mkdir(filePath: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(filePath: string, encoding: "utf8"): Promise<string>;
  export function access(filePath: string): Promise<void>;
  export function writeFile(filePath: string, content: string): Promise<void>;
}

declare module "node:os" {
  export function tmpdir(): string;
  export function homedir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(filePath: string): string;
}

declare const process: {
  cwd(): string;
  env?: Record<string, string | undefined>;
};

declare const Bun: {
  file(filePath: string): { text(): Promise<string> };
  write(filePath: string, content: string): Promise<number>;
  YAML: { parse(text: string): unknown };
};
